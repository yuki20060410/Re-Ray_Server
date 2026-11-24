// 音声【案】のテスト。ブローカーも文字起こしのサーバーも使わない(2026-11-24 作成)

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ChannelService } from "../server/channels.js";
import { PcSeq } from "../server/pcSeq.js";
import { Sender, TRANSCRIPT_MAX } from "../server/sender.js";
import { MemoryStorage } from "../storage/memory.js";
import { VOICE_MAX_ATTEMPTS, VoiceError, VoiceService } from "./service.js";
import type { Transcriber } from "./transcriber.js";
import { makeWav, readWav, VOICE_MAX_MS, WavError } from "./wav.js";

const T0 = Date.parse("2026-11-24T00:00:00.000Z");
const quiet = { info() {}, warn() {}, error() {} };
const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** 文字起こしの代わり: 決まった答えを順に返す(Error なら throw) */
function fakeTranscriber(answers: (string | Error)[]): Transcriber & { calls: number } {
  return {
    label: "テスト",
    calls: 0,
    async transcribe() {
      const a = answers[this.calls++] ?? answers.at(-1) ?? "";
      if (a instanceof Error) throw a;
      return a;
    },
  };
}

async function setup(answers: (string | Error)[], opts: { failPublishOnce?: boolean } = {}) {
  const storage = new MemoryStorage();
  const dir = await mkdtemp(join(tmpdir(), "reray-voice-"));
  dirs.push(dir);
  const now = () => new Date(T0);
  const published: { topic: string; body: Record<string, unknown> }[] = [];
  let failPublish = opts.failPublishOnce ?? false;
  const channels = new ChannelService({ storage, pcSeq: new PcSeq(0), publishRetained: async () => {}, now, log: quiet });
  const sender = new Sender({
    storage,
    pcSeq: new PcSeq(10),
    now,
    log: quiet,
    channels,
    publish: async (topic, payload) => {
      if (failPublish) {
        failPublish = false; // 1 回だけ失敗する
        throw new Error("not connected");
      }
      published.push({ topic, body: JSON.parse(payload) });
    },
  });
  const transcriber = fakeTranscriber(answers);
  const voice = new VoiceService({ storage, sender, transcriber, dir, now, log: quiet, retryDelaysMs: [1, 1] });
  await storage.registerDevice("dev-001", "山田", new Date(T0));
  await storage.registerDevice("dev-002", "佐藤", new Date(T0));
  await storage.registerDevice("dev-003", "鈴木", new Date(T0));
  const g = await channels.createGroup("北班", ["dev-001", "dev-002"]);
  return { storage, voice, transcriber, published, ch: g.ch, dir };
}

async function rejects(p: Promise<unknown>, status: number, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof VoiceError && e.status === status && e.code === code);
}

describe("WAV", () => {
  it("ヘッダから長さを読む", () => {
    assert.deepEqual(readWav(makeWav(3000)), { sampleRate: 16000, channels: 1, bitsPerSample: 16, durationMs: 3000 });
  });

  it("data の大きさが 0(録音しながら書いた)なら、残り全部を data とする", () => {
    const w = makeWav(2000);
    w.writeUInt32LE(0, 40);
    assert.equal(readWav(w).durationMs, 2000);
  });

  it("WAV でない・圧縮・8 ビットは断る", () => {
    assert.throws(() => readWav(Buffer.from("hello world, this is not a wav file at all......")), WavError);
    const comp = makeWav(100);
    comp.writeUInt16LE(3, 20); // float
    assert.throws(() => readWav(comp), /圧縮/);
    const bits8 = makeWav(100);
    bits8.writeUInt16LE(8, 34);
    assert.throws(() => readWav(bits8), /16 ビット/);
  });
});

describe("音声【案】", () => {
  it("受け取ると 202 用の id を返し、文字にして、そのチャンネルに話した人付きで配る(本人にも)", async () => {
    const { storage, voice, published, ch, dir } = await setup(["北口の点検が終わりました"]);
    const wav = makeWav(3000);
    const r = await voice.accept({ device: "dev-001", ch: String(ch), seq: "123", wav });
    assert.equal(r.duplicate, false);
    assert.deepEqual(await readFile(join(dir, `${r.id}.wav`)), wav);

    await voice.idle();
    const clip = await storage.getVoice(r.id);
    assert.deepEqual([clip?.status, clip?.text, clip?.attempts, clip?.durationMs], ["done", "北口の点検が終わりました", 1, 3000]);
    assert.deepEqual(
      published.map((p) => [p.topic, p.body.ch, p.body.from, p.body.from_name, p.body.body]),
      [
        ["reray/v1/down/dev-001/text", ch, "dev-001", "山田", "北口の点検が終わりました"],
        ["reray/v1/down/dev-002/text", ch, "dev-001", "山田", "北口の点検が終わりました"],
      ],
    );
    const m = await storage.getMessage(clip!.messageId!);
    assert.deepEqual([m?.source, m?.ch, m?.from], ["transcript", ch, "dev-001"]);
  });

  it("送り直し(同じ番号)は前の id を返し、文字起こしは 1 回だけ", async () => {
    const { voice, transcriber, ch } = await setup(["はい"]);
    const a = await voice.accept({ device: "dev-001", ch, seq: 5, wav: makeWav(1000) });
    const b = await voice.accept({ device: "dev-001", ch, seq: 5, wav: makeWav(1000) });
    await voice.idle();
    assert.deepEqual([b.id, b.duplicate], [a.id, true]);
    assert.equal(transcriber.calls, 1);
  });

  it("声が無ければ配らない(empty)", async () => {
    const { storage, voice, published, ch } = await setup(["  "]);
    const r = await voice.accept({ device: "dev-001", ch, seq: 1, wav: makeWav(500) });
    await voice.idle();
    assert.equal((await storage.getVoice(r.id))?.status, "empty");
    assert.equal(published.length, 0);
  });

  it("長い文は 200 文字で切って配る。記録には全文を残す", async () => {
    const long = "あ".repeat(TRANSCRIPT_MAX + 20);
    const { storage, voice, published, ch } = await setup([long]);
    const r = await voice.accept({ device: "dev-001", ch, seq: 1, wav: makeWav(1000) });
    await voice.idle();
    const body = published[0]?.body.body as string;
    assert.equal([...body].length, TRANSCRIPT_MAX);
    assert.ok(body.endsWith("…"));
    assert.equal((await storage.getVoice(r.id))?.text, long);
  });

  it("文字起こしが失敗したらやり直す。続けて失敗したらあきらめる", async () => {
    const ok = await setup([new Error("timeout"), "こんにちは"]);
    const r1 = await ok.voice.accept({ device: "dev-001", ch: ok.ch, seq: 1, wav: makeWav(1000) });
    await ok.voice.idle();
    assert.deepEqual([(await ok.storage.getVoice(r1.id))?.status, (await ok.storage.getVoice(r1.id))?.attempts], ["done", 2]);

    const ng = await setup([new Error("down")]);
    const r2 = await ng.voice.accept({ device: "dev-001", ch: ng.ch, seq: 1, wav: makeWav(1000) });
    await ng.voice.idle();
    const c = await ng.storage.getVoice(r2.id);
    assert.deepEqual([c?.status, c?.attempts, c?.error], ["failed", VOICE_MAX_ATTEMPTS, "down"]);
  });

  it("文字にできたが配れなかったときは、配るところだけやり直す", async () => {
    const s = await setup(["了解しました"], { failPublishOnce: true });
    const r = await s.voice.accept({ device: "dev-001", ch: s.ch, seq: 1, wav: makeWav(1000) });
    await s.voice.idle();
    const c = await s.storage.getVoice(r.id);
    assert.deepEqual([c?.status, c?.attempts], ["done", 2]);
    assert.equal(s.transcriber.calls, 1);
    // 1 回目に配れなかった分は failed で記録に残り、2 回目の 1 通が届く
    assert.equal(s.published.length, 2);
  });

  it("再起動したら、文字起こし待ちを拾い直す", async () => {
    const s = await setup(["拾い直し"]);
    const rec = await s.storage.recordVoice(
      { deviceId: "dev-001", ch: s.ch, seq: 9, durationMs: 1000, bytes: 32044, receivedAt: new Date(T0) },
      1000,
    );
    const { writeFile } = await import("node:fs/promises");
    await writeFile(s.voice.audioPath(rec.clip.id), makeWav(1000));
    await s.voice.start();
    await s.voice.idle();
    assert.equal((await s.storage.getVoice(rec.clip.id))?.status, "done");
  });

  it("確かめて断る: 端末・チャンネル・番号・WAV・長さ", async () => {
    const { voice, ch } = await setup(["x"]);
    const wav = makeWav(1000);
    await rejects(voice.accept({ device: "dev-1", ch, seq: 1, wav }), 400, "bad_device");
    await rejects(voice.accept({ device: "dev-099", ch, seq: 1, wav }), 422, "unknown_device");
    await rejects(voice.accept({ device: "dev-001", ch: 999, seq: 1, wav }), 422, "unknown_channel");
    await rejects(voice.accept({ device: "dev-003", ch, seq: 1, wav }), 422, "not_member");
    await rejects(voice.accept({ device: "dev-001", ch: "x", seq: 1, wav }), 400, "bad_header");
    await rejects(voice.accept({ device: "dev-001", ch, seq: 70000, wav }), 400, "bad_header");
    await rejects(voice.accept({ device: "dev-001", ch, seq: 1, wav: Buffer.from("not a wav") }), 422, "bad_wav");
    await rejects(voice.accept({ device: "dev-001", ch, seq: 1, wav: makeWav(VOICE_MAX_MS + 1000) }), 422, "too_long");
  });
});
