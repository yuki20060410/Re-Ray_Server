// 音声【案】(端末からの依頼 2026-11-17 の #4。端末の設計 DESIGN.md §5.3)
//
// 流れ: 端末が POST /api/voice で WAV を送る → 確かめて記録し、ファイルに置く → すぐ 202 を返す →
//       順番に文字起こし → 文字になったら、そのチャンネルに「話した人」付きの文として配る(source = transcript)
// - 端末は 202 が来なければ同じ番号(X-Seq)で送り直す。10 分以内の同じ番号は、前の記録の id を返す(音は 1 回だけ)
// - 文字起こしは 1 本ずつ(CPU だけの faster-whisper に同時に投げると、かえって遅くなる)
// - 失敗したら少し待ってやり直す(3 回まで)。文字にできたが配れなかったときは、配るところだけやり直す
// - サーバーを再起動したら、文字起こし待ち(queued)を拾い直す
// HTTP には依存しない。2026-11-24 作成

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deviceNumber } from "../protocol/topics.js";
import { SendError, TRANSCRIPT_MAX, type Sender } from "../server/sender.js";
import type { DeviceId, Storage, VoiceClip } from "../storage/types.js";
import type { Transcriber } from "./transcriber.js";
import { readWav, VOICE_MAX_BYTES, VOICE_MAX_MS, WavError } from "./wav.js";

/** 送り直しとみなす範囲(定型信号と同じ 10 分) */
export const VOICE_DEDUP_WINDOW_MS = 10 * 60 * 1000;
/** 文字起こしと配るのを試す回数 */
export const VOICE_MAX_ATTEMPTS = 3;
/** やり直すまでの待ち(1 回目の失敗のあと、2 回目の失敗のあと) */
const RETRY_DELAYS_MS = [5_000, 30_000];

export class VoiceError extends Error {
  constructor(
    readonly status: 400 | 404 | 413 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface VoiceRequest {
  /** X-Device */
  device: unknown;
  /** X-Channel */
  ch: unknown;
  /** X-Seq */
  seq: unknown;
  wav: Buffer;
}

export interface VoiceServiceDeps {
  storage: Storage;
  sender: Pick<Sender, "sendToChannel">;
  transcriber: Transcriber;
  /** 音のファイルを置くフォルダー(VOICE_DIR) */
  dir: string;
  now?: () => Date;
  log?: Pick<Console, "info" | "warn" | "error">;
  /** テスト用: やり直すまでの待ち */
  retryDelaysMs?: number[];
}

export class VoiceService {
  private readonly storage: Storage;
  private readonly sender: VoiceServiceDeps["sender"];
  private readonly transcriber: Transcriber;
  private readonly dir: string;
  private readonly now: () => Date;
  private readonly log: NonNullable<VoiceServiceDeps["log"]>;
  private readonly retryDelays: number[];
  private readonly queue: number[] = [];
  private readonly timers = new Set<NodeJS.Timeout>();
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(deps: VoiceServiceDeps) {
    this.storage = deps.storage;
    this.sender = deps.sender;
    this.transcriber = deps.transcriber;
    this.dir = deps.dir;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? console;
    this.retryDelays = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
  }

  get transcriberLabel(): string {
    return this.transcriber.label;
  }

  /** 音のファイルの場所 */
  audioPath(id: number): string {
    return join(this.dir, `${id}.wav`);
  }

  /** 受け取る。確かめて記録し、文字起こしの列に入れる。送り直しなら前の id を返す */
  async accept(req: VoiceRequest): Promise<{ id: number; duplicate: boolean }> {
    const deviceId = await this.checkDevice(req.device);
    const ch = await this.checkChannel(req.ch, deviceId);
    const seq = intHeader(req.seq, 0, 65535, "X-Seq(端末の番号)は 0〜65535 です");
    if (req.wav.length > VOICE_MAX_BYTES) throw new VoiceError(413, "too_large", "音声が大きすぎます");
    let durationMs: number;
    try {
      durationMs = readWav(req.wav).durationMs;
    } catch (err) {
      if (err instanceof WavError) throw new VoiceError(422, "bad_wav", err.message);
      throw err;
    }
    if (durationMs > VOICE_MAX_MS) {
      throw new VoiceError(422, "too_long", `音声は ${VOICE_MAX_MS / 1000} 秒までです(${(durationMs / 1000).toFixed(1)} 秒)`);
    }

    const r = await this.storage.recordVoice(
      { deviceId, ch, seq, durationMs, bytes: req.wav.length, receivedAt: this.now() },
      VOICE_DEDUP_WINDOW_MS,
    );
    if (r.kind === "duplicate") return { id: r.clip.id, duplicate: true };

    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.audioPath(r.clip.id), req.wav);
    } catch (err) {
      await this.storage.updateVoice(r.clip.id, { status: "failed", error: `ファイルに書けない: ${String(err)}` });
      throw err;
    }
    this.log.info(`音声を受けた: id=${r.clip.id} ${deviceId} → ch ${ch}(${(durationMs / 1000).toFixed(1)} 秒)`);
    this.enqueue(r.clip.id);
    return { id: r.clip.id, duplicate: false };
  }

  /** 再起動したとき: 文字起こし待ちを、古い順に列に戻す */
  async start(): Promise<void> {
    const pending = await this.storage.listVoices({ statuses: ["queued"], limit: 1000 });
    for (const v of pending.reverse()) this.enqueue(v.id);
    if (pending.length) this.log.info(`文字起こし待ちの音声を ${pending.length} 件拾い直した`);
  }

  /** 止める(やり直しの予約を消す。途中の 1 本は終わるまで待つ) */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    await this.running;
  }

  /** テスト用: 列が空になり、やり直しの予約も無くなるまで待つ */
  async idle(): Promise<void> {
    while (this.running || this.queue.length || this.timers.size) {
      await (this.running ?? new Promise((r) => setTimeout(r, 5)));
    }
  }

  // ---- 内部 ----

  private enqueue(id: number): void {
    if (this.stopped || this.queue.includes(id)) return;
    this.queue.push(id);
    this.kick();
  }

  /** 列を処理し始める。終わる間際に入ったものが取り残されないよう、残っていればもう一度始める */
  private kick(): void {
    if (this.running || this.stopped) return;
    this.running = this.work().finally(() => {
      this.running = null;
      if (this.queue.length) this.kick();
    });
  }

  private async work(): Promise<void> {
    for (let id = this.queue.shift(); id !== undefined; id = this.queue.shift()) {
      try {
        await this.process(id);
      } catch (err) {
        this.log.error(`音声 id=${id} の処理で思わぬエラー`, err);
      }
    }
  }

  private async process(id: number): Promise<void> {
    const clip = await this.storage.getVoice(id);
    if (!clip || clip.status !== "queued") return;
    const attempts = clip.attempts + 1;
    try {
      // 前の回で文字にできていれば、配るところだけやり直す
      const text = clip.text ?? (await this.transcribe(clip));
      if (!text) {
        await this.storage.updateVoice(id, { status: "empty", text: "", attempts, error: null, doneAt: this.now() });
        this.log.info(`音声 id=${id}: 声が無かった(配らない)`);
        return;
      }
      await this.storage.updateVoice(id, { text });
      const m = await this.sender.sendToChannel({
        ch: clip.ch,
        body: truncate(text, TRANSCRIPT_MAX),
        source: "transcript",
        from: clip.deviceId,
      });
      await this.storage.updateVoice(id, { status: "done", messageId: m.id, attempts, error: null, doneAt: this.now() });
      this.log.info(`音声 id=${id} → 文字にして配った(mid=${m.id}): ${truncate(text, 30)}`);
    } catch (err) {
      const giveUp = attempts >= VOICE_MAX_ATTEMPTS || (err instanceof SendError && err.status !== 503);
      const error = errorText(err);
      await this.storage.updateVoice(id, {
        attempts,
        error,
        ...(giveUp && { status: "failed" as const, doneAt: this.now() }),
      });
      if (giveUp) {
        this.log.error(`音声 id=${id} をあきらめた(${attempts} 回目): ${error}`);
        return;
      }
      const delay = this.retryDelays[attempts - 1] ?? this.retryDelays.at(-1) ?? 30_000;
      this.log.warn(`音声 id=${id} の ${attempts} 回目が失敗。${delay / 1000} 秒後にやり直す: ${error}`);
      const t = setTimeout(() => {
        this.timers.delete(t);
        this.enqueue(id);
      }, delay);
      this.timers.add(t);
    }
  }

  private async transcribe(clip: VoiceClip): Promise<string> {
    const wav = await readFile(this.audioPath(clip.id));
    return (await this.transcriber.transcribe(wav, { durationMs: clip.durationMs })).trim();
  }

  /** 登録した端末だけ(登録していない端末の声は配れない) */
  private async checkDevice(v: unknown): Promise<DeviceId> {
    if (typeof v !== "string" || deviceNumber(v) === null) {
      throw new VoiceError(400, "bad_device", "X-Device(端末ID)は dev-001 の形で入れてください");
    }
    if (!(await this.storage.getDevice(v))?.registered) {
      throw new VoiceError(422, "unknown_device", `${v} は登録されていません`);
    }
    return v;
  }

  /** その端末が入っているチャンネルだけ */
  private async checkChannel(v: unknown, deviceId: DeviceId): Promise<number> {
    const ch = intHeader(v, 1, 65535, "X-Channel(チャンネルの番号)が正しくありません");
    const channel = await this.storage.getChannel(ch);
    if (!channel) throw new VoiceError(422, "unknown_channel", `チャンネル ${ch} はありません`);
    if (!channel.members.includes(deviceId)) {
      throw new VoiceError(422, "not_member", `${deviceId} はチャンネル ${ch} に入っていません`);
    }
    return ch;
  }
}

function intHeader(v: unknown, min: number, max: number, message: string): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (!Number.isInteger(n) || (n as number) < min || (n as number) > max) throw new VoiceError(400, "bad_header", message);
  return n as number;
}

/** 文字の数で切る(はみ出したら最後を「…」にする) */
export function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 255);
}
