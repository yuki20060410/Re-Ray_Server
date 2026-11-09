// 上りを 1 件ずつ受けて、保存し、端末へ「本部に届いた」を返す(DATAFLOW §1〜§4)
//
// MQTT には依存しない(テストではブローカーなしで呼ぶ)。順番:
// 1. events に原本を書く → 2. 確かめる(だめなら invalid)→ 3. 重複の判定と保存 →
// 4. signal なら、重複で捨てた場合も含めて「本部に届いた」を返す
// 2026-11-06: ack の対応づけ(M3)と、了解・できない(ack_kind 4・5)、範囲外の印を足した

import { downAckTopic } from "../protocol/topics.js";
import { MAX_PAYLOAD_BYTES, parseUp, type AckMessage, type SignalMessage, type UpMessage } from "../protocol/validate.js";
import type { AckResponse, EventResult, Storage } from "../storage/types.js";
import type { PcSeq } from "./pcSeq.js";

/** 重複とみなす範囲(直近 10 分の同じ src + seq。ARCHITECTURE §6) */
export const DEDUP_WINDOW_MS = 10 * 60 * 1000;

/** ack_seq だけの ack を対応づけるとき、さかのぼる範囲(INTERFACES §2.4 の暫定) */
export const ACK_SEQ_WINDOW_MS = 10 * 60 * 1000;

export interface ReceiverDeps {
  storage: Storage;
  /** QoS 1・retain なしで流す。ブローカーが受け取ったら(PUBACK)解決する */
  publish: (topic: string, payload: string) => Promise<void>;
  pcSeq: PcSeq;
  now?: () => Date;
  log?: Pick<Console, "info" | "warn" | "error">;
}

export interface HandleOutcome {
  result: EventResult;
  note?: string;
}

export class Receiver {
  private readonly storage: Storage;
  private readonly publish: ReceiverDeps["publish"];
  private readonly pcSeq: PcSeq;
  private readonly now: () => Date;
  private readonly log: NonNullable<ReceiverDeps["log"]>;
  private readonly sending = new Set<Promise<void>>();

  constructor(deps: ReceiverDeps) {
    this.storage = deps.storage;
    this.publish = deps.publish;
    this.pcSeq = deps.pcSeq;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? console;
  }

  /** 1 件を処理する。保存が終わってから戻る(MQTT の受け取りの返事は、このあとで返す) */
  async handle(topic: string, payload: Uint8Array): Promise<HandleOutcome> {
    const receivedAt = this.now();
    const eventId = await this.storage.saveEvent({
      at: receivedAt,
      direction: "up",
      topic,
      payload: eventPayload(topic, payload),
      result: "pending",
    });

    const parsed = parseUp(topic, payload);
    const outcome: HandleOutcome = parsed.ok
      ? await this.dispatch(parsed.message, receivedAt)
      : { result: "invalid", note: parsed.reason };

    await this.storage.setEventResult(eventId, outcome.result, outcome.note);
    const line = `${topic} → ${outcome.result}${outcome.note ? ` (${outcome.note})` : ""}`;
    if (outcome.result === "invalid") this.log.warn(line);
    else this.log.info(line);
    return outcome;
  }

  /** 流している途中の「本部に届いた」が全部終わるまで待つ(テストと、止めるとき用) */
  async drain(): Promise<void> {
    while (this.sending.size > 0) await Promise.allSettled([...this.sending]);
  }

  private async dispatch(message: UpMessage, receivedAt: Date): Promise<HandleOutcome> {
    switch (message.type) {
      case "signal": {
        const r = await this.storage.recordSignal(
          {
            deviceId: message.src,
            seq: message.seq,
            code: message.code,
            pos: message.pos,
            ...(message.n !== undefined && { n: message.n }),
            ...(message.dir !== undefined && { dir: message.dir }),
            via: message.via,
            deviceTs: message.ts === null ? null : new Date(message.ts * 1000),
            receivedAt,
            outOfRange: isOutOfRange(message),
          },
          DEDUP_WINDOW_MS,
        );
        // 重複で捨てた signal にも返す(端末が送り直しをやめられるように。INTERFACES §2.6)
        this.sendHqAck(message.src, message.seq);
        return r.kind === "saved" ? { result: "accepted" } : { result: "duplicate" };
      }
      case "status": {
        const { type: _type, src, seq: _seq, ts: _ts, ...values } = message;
        await this.storage.recordStatus({ deviceId: src, receivedAt, ...values });
        return { result: "accepted" };
      }
      case "lastwill":
        await this.storage.markOffline(message.src, "lastwill", receivedAt);
        return { result: "accepted" };
      case "ack":
        // 対応づけられなくても、端末から何か届いたことは反映する(ARCHITECTURE §5)
        await this.storage.touchDevice(message.src, receivedAt);
        return this.matchAck(message, receivedAt);
      case "gateway":
        // LoRa のフレームの分解は次に作る(GATEWAY_RAW_FORMAT)。今は原本だけ残す
        return { result: "ignored", note: "lora decode not yet" };
    }
  }

  /**
   * ack を、どの 1 通への確認かに対応づけて残す(INTERFACES §2.4 の暫定)。
   * - `ack_mid` がある → messages.id に直接
   * - `ack_seq` だけ → 直近 10 分に同じ seq で送り、この端末が宛先に入っている 1 通。
   *   2 通以上あれば曖昧なので対応づけない(unmatched。原本に残る)
   */
  private async matchAck(message: AckMessage, receivedAt: Date): Promise<HandleOutcome> {
    if (message.ackMid === undefined && message.ackSrc !== undefined && message.ackSrc !== "pc") {
      return { result: "ignored", note: "ack_src not pc" };
    }

    let mid = message.ackMid;
    if (mid === undefined) {
      const since = new Date(receivedAt.getTime() - ACK_SEQ_WINDOW_MS);
      const sameSeq = await this.storage.findMessagesBySeq(message.ackSeq ?? -1, since);
      const deliveries = await this.storage.listDeliveries(sameSeq.map((m) => m.id));
      const mine = sameSeq.filter((m) => deliveries.get(m.id)?.some((d) => d.deviceId === message.src));
      if (mine.length === 0) return { result: "unmatched", note: "no message for ack_seq" };
      if (mine.length > 1) return { result: "unmatched", note: "ambiguous ack_seq" };
      mid = mine[0]?.id;
    }
    if (mid === undefined) return { result: "unmatched", note: "no message for ack_seq" };

    const response: AckResponse | undefined =
      message.ackKind === 4 ? "accepted" : message.ackKind === 5 ? "declined" : undefined;
    const r = await this.storage.recordAck(mid, message.src, receivedAt, response);
    switch (r.kind) {
      case "saved":
        return { result: "accepted", note: `mid=${mid}${response ? ` ${response}` : ""}` };
      case "duplicate":
        return { result: "duplicate", note: `mid=${mid}` };
      case "not_target":
        return { result: "unmatched", note: `mid=${mid} not a target` };
    }
  }

  /**
   * 「本部に届いた」を流す。**完了を待たずに戻る。**
   * MQTT.js は受け取ったものを 1 件ずつ順に処理するので、処理の中でこちらの publish の
   * 受け取りの返事(PUBACK)を待つと、その返事の処理が後ろに並んで詰まってしまう。
   * 流せたか・流せなかったかは、終わったときに events に残す。
   */
  private sendHqAck(deviceId: string, ackSeq: number): void {
    const at = this.now();
    const topic = downAckTopic(deviceId);
    const payload = JSON.stringify({
      v: 1,
      type: "ack",
      src: "pc",
      seq: this.pcSeq.next(),
      ts: Math.floor(at.getTime() / 1000),
      ack_src: deviceId,
      ack_seq: ackSeq,
    });

    const job = this.publish(topic, payload)
      .then(
        () => ({ result: "sent" as const }),
        (err: unknown) => {
          this.log.error(`本部に届いたを流せなかった: ${topic}`, err);
          return { result: "failed" as const, note: String(err).slice(0, 255) };
        },
      )
      .then((r) => this.storage.saveEvent({ at, direction: "down", topic, payload, ...r }))
      .then(
        () => undefined,
        (err: unknown) => this.log.error("下りの原本を書けなかった", err),
      );
    this.sending.add(job);
    void job.finally(() => this.sending.delete(job));
  }
}

/**
 * 【案】数量 n・方角 dir が区分外・範囲外か(SIGNAL_FORMAT §2。保存はするが、画面で印を付ける)。
 * n は 5 人きざみの 5〜100、dir は 1〜8。一覧(signal_codes)と合っているかまでは見ない
 */
export function isOutOfRange(m: Pick<SignalMessage, "n" | "dir">): boolean {
  const badN = m.n !== undefined && !(m.n >= 5 && m.n <= 100 && m.n % 5 === 0);
  const badDir = m.dir !== undefined && !(m.dir >= 1 && m.dir <= 8);
  return badN || badDir;
}

/** 原本に入れる文字列。生渡しのバイナリは 16 進、それ以外は UTF-8(4 KB で切る) */
function eventPayload(topic: string, payload: Uint8Array): string {
  const bytes = payload.subarray(0, MAX_PAYLOAD_BYTES);
  if (topic.endsWith("/lora")) return Buffer.from(bytes).toString("hex");
  return Buffer.from(bytes).toString("utf8");
}
