// 本部から端末へ、文字・指示コードを送る(M3。INTERFACES §2.1・§4.1、ARCHITECTURE §4)
//
// 順番: 確かめる → 宛先と送った時の経路を決める → **DB に保存して id(= mid)を得る** → MQTT に流す →
//       流せたか(sent / failed)を残す。流せなければ 503(保存した行は failed で残す)
// HTTP には依存しない(API からも、文字起こしの入口からも、テストからも同じものを呼ぶ)。
// 2026-11-06 作成(reray-app の server.js の POST /api/messages を、窓口を使う形に直して取り込んだ)

// 2026-11-24: チャンネルの文(sendToChannel)を足した。チャンネルの文は、入っている端末 1 台ずつに
//   `down/{id}/text` で流す(端末からの依頼 #3)。文には ch・from・from_name を付ける。
//   1 台あての文には、その端末の 1 対 1 のチャンネルの ch を付ける(端末が「本部」に入れられるように)

import { deviceNumber, downTextTopic } from "../protocol/topics.js";
import type { Device, DeviceId, Message, MessageSource, MessageTarget, NewMessage, Storage, ViaAtSend } from "../storage/types.js";
import type { ChannelService } from "./channels.js";
import type { PcSeq } from "./pcSeq.js";

/** 本部が言ったときの from_name */
export const HQ_NAME = "本部";

/**
 * 本文の上限(全角40文字【案】。INTERFACES §2.1)。グラスに何文字出せるかが決まったら、ここだけ変える。
 * 数え方は文字(コードポイント)の数。指示コードから作った文にも同じ上限をかける
 */
export const BODY_MAX = 40;

/**
 * 【案】文字起こしの文の上限(2026-11-24)。声を文字にした文は 40 文字に収まらない(端末からの依頼 §4.3)。
 * グラスは長い文をページに分けて出す。端末の受信の入れ物(2048 バイト)に、ほかの項目と一緒に収まる長さ。
 * DB は messages.body を VARCHAR(255) にする(db/init/03_server.sql)
 */
export const TRANSCRIPT_MAX = 200;

/** 送れなかった理由。status は API がそのまま返す(INTERFACES §4.4) */
export class SendError extends Error {
  constructor(
    readonly status: 400 | 422 | 503,
    readonly code: string,
    message: string,
    /** 保存したあとで流せなかったときの messages.id */
    readonly messageId?: number,
  ) {
    super(message);
  }
}

export type SendRequest =
  | { dst: string; kind: "free"; body: string; source?: MessageSource }
  | { dst: string; kind: "order"; icode: number; pos: number };

/** 【案】チャンネルの文。from が無ければ本部が言った文 */
export interface ChannelSendRequest {
  ch: number;
  body: string;
  source?: MessageSource;
  from?: DeviceId;
}

export interface SenderDeps {
  storage: Storage;
  pcSeq: PcSeq;
  /** QoS 1・retain なしで流す。ブローカーにつながっていなければ、待たずに失敗すること */
  publish: (topic: string, payload: string) => Promise<void>;
  /** 1 台あての文に 1 対 1 のチャンネルの ch を付けるのに使う。無ければ ch を付けない */
  channels?: Pick<ChannelService, "ensureDirect">;
  now?: () => Date;
  log?: Pick<Console, "info" | "warn" | "error">;
}

export class Sender {
  private readonly storage: Storage;
  private readonly pcSeq: PcSeq;
  private readonly publish: SenderDeps["publish"];
  private readonly channels: SenderDeps["channels"];
  private readonly now: () => Date;
  private readonly log: NonNullable<SenderDeps["log"]>;

  constructor(deps: SenderDeps) {
    this.storage = deps.storage;
    this.pcSeq = deps.pcSeq;
    this.publish = deps.publish;
    this.channels = deps.channels;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? console;
  }

  /** 送る。保存した 1 通(publishState は sent)を返す。だめなら SendError */
  async send(req: SendRequest): Promise<Message> {
    const dst = await this.checkDst(req.dst);
    const content =
      req.kind === "free"
        ? { body: checkBody(req.body, req.source === "transcript" ? TRANSCRIPT_MAX : BODY_MAX), pos: 0 }
        : await this.orderContent(req.icode, req.pos);
    const devices = dst === "all" ? await this.storage.listDevices() : [await this.storage.getDevice(dst)];
    const ch = dst !== "all" && this.channels ? (await this.channels.ensureDirect(dst)).ch : undefined;

    return this.saveAndPublish(
      {
        seq: this.pcSeq.next(),
        dst,
        body: content.body,
        kind: req.kind,
        ...(req.kind === "order" && { icode: req.icode, pos: content.pos }),
        source: req.kind === "free" ? (req.source ?? "web") : "web",
        sentAt: this.now(),
        ...(ch !== undefined && { ch }),
      },
      devices.filter((d): d is Device => d !== null),
      // 1 台あて・一斉は、今までどおり 1 回だけ流す
      [dst],
    );
  }

  /** 【案】チャンネルの文を送る。入っている端末 1 台ずつに流す(話した本人にも返す) */
  async sendToChannel(req: ChannelSendRequest): Promise<Message> {
    const channel = Number.isInteger(req.ch) ? await this.storage.getChannel(req.ch) : null;
    if (!channel) throw new SendError(422, "unknown_channel", "そのチャンネルはありません");
    if (!channel.members.length) throw new SendError(422, "empty_channel", "そのチャンネルには端末が入っていません");
    const body = checkBody(req.body, req.source === "transcript" ? TRANSCRIPT_MAX : BODY_MAX);
    const devices = (await Promise.all(channel.members.map((id) => this.storage.getDevice(id)))).filter(
      (d): d is Device => d !== null,
    );

    return this.saveAndPublish(
      {
        seq: this.pcSeq.next(),
        dst: "all",
        body,
        kind: "free",
        source: req.source ?? "web",
        sentAt: this.now(),
        ch: channel.ch,
        ...(req.from !== undefined && { from: req.from }),
      },
      devices,
      channel.members,
    );
  }

  /**
   * 宛先と送った時の経路を決め、**DB に保存して id(= mid)を得てから**流す。
   * dsts(流す先)が 2 つ以上(チャンネル)なら、1 台ずつ流す。1 つでも流せなければ failed で 503
   */
  private async saveAndPublish(m: NewMessage, devices: Device[], dsts: (DeviceId | "all")[]): Promise<Message> {
    // 宛先と、送った時の経路(あとで端末の状態が変わっても、当時の分母が残る。INTERFACES §4.1)
    const targets: MessageTarget[] = devices.map((d) => {
      const viaAtSend: ViaAtSend = d.online ? (d.via ?? "wifi") : "offline";
      // 【案】自由な文は LoRa では運ばない(10/20 の決定)。LoRa 中の端末は別に数える(B 案の is_skipped)
      return { deviceId: d.id, viaAtSend, skipped: m.kind === "free" && viaAtSend === "lora" };
    });
    const saved = await this.storage.createMessage(m, targets);
    const fromName = saved.from === undefined ? HQ_NAME : ((await this.storage.getDevice(saved.from))?.owner ?? saved.from);

    for (const dst of dsts) {
      const topic = downTextTopic(dst);
      const payload = JSON.stringify({
        v: 1,
        type: "text",
        src: "pc",
        dst,
        seq: saved.seq,
        mid: saved.id,
        ts: Math.floor(saved.sentAt.getTime() / 1000),
        ...(saved.icode !== undefined && { icode: saved.icode, pos: saved.pos ?? 0 }),
        // 【案】どのチャンネルの文か、だれが言ったか(端末からの依頼 §4.2)
        ...(saved.ch !== undefined && { ch: saved.ch }),
        from: saved.from ?? "pc",
        from_name: fromName,
        body: saved.body,
      });

      try {
        await this.publish(topic, payload);
      } catch (err) {
        this.log.error(`送れなかった(mid=${saved.id}): ${topic}`, err);
        await this.storage.setPublishState(saved.id, "failed");
        await this.storage.saveEvent({ at: saved.sentAt, direction: "down", topic, payload, result: "failed", note: String(err).slice(0, 255) });
        throw new SendError(503, "mqtt_unavailable", "ブローカーにつながっていないので送れませんでした(記録は残しました)", saved.id);
      }
      await this.storage.saveEvent({ at: saved.sentAt, direction: "down", topic, payload, result: "sent" });
    }
    await this.storage.setPublishState(saved.id, "sent");
    const where = dsts.length === 1 ? downTextTopic(dsts[0] ?? "all") : `ch ${saved.ch}(${dsts.length} 台に 1 通ずつ)`;
    this.log.info(`${where} → sent (mid=${saved.id}, ${targets.length} 台)`);
    return { ...saved, publishState: "sent" };
  }

  /** 宛先は "all" か、登録した端末(INTERFACES §4.1: 登録されていない端末ID は 422) */
  private async checkDst(dst: string): Promise<DeviceId | "all"> {
    if (dst === "all") return "all";
    if (typeof dst !== "string" || deviceNumber(dst) === null) {
      throw new SendError(400, "bad_dst", "送り先は端末ID(dev-001 の形)か all で指定してください");
    }
    const d = await this.storage.getDevice(dst);
    if (!d?.registered) throw new SendError(422, "unknown_device", `${dst} は登録されていません`);
    return dst;
  }

  /** 指示コードの形: 指示コード表とポジション表から文を作る */
  private async orderContent(icode: number, pos: number): Promise<{ body: string; pos: number }> {
    const code = Number.isInteger(icode)
      ? (await this.storage.listInstructionCodes()).find((c) => c.code === icode)
      : undefined;
    if (!code) throw new SendError(422, "unknown_icode", "指示コードが一覧にありません");
    if (!code.usesPosition) return { body: checkBody(code.textWithoutPos ?? code.name), pos: 0 };

    // ポジションは表に無くても送れる(番号のまま。INTERFACES §4.1)
    if (!Number.isInteger(pos) || pos < 1 || pos > 255) {
      throw new SendError(422, "bad_pos", "ポジションを選んでください(1〜255)");
    }
    const p = (await this.storage.listPositions()).find((x) => x.no === pos);
    const text = (code.textWithPos ?? "{ポジション名}").replace("{ポジション名}", p?.name ?? `ポジション${pos}`);
    return { body: checkBody(text), pos };
  }
}

function checkBody(body: unknown, max = BODY_MAX): string {
  const text = typeof body === "string" ? body.trim() : "";
  if (!text) throw new SendError(422, "empty_body", "本文を入れてください");
  if ([...text].length > max) throw new SendError(422, "body_too_long", `本文は${max}文字までです`);
  return text;
}
