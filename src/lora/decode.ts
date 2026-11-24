// 出口の生渡しを、JSON で届いたものと同じ形(SignalMessage・AckMessage)に直す(GATEWAY_RAW_FORMAT §2)
//
// 直したあとは、Wi-Fi の端末の JSON と**同じ処理**(重複の判定 → 保存 → 本部に届いた)を通す。
// 2026-11-24 作成【案】。テスト用データでの答え合わせはまだ(frame.ts の冒頭)

import { formatDeviceId } from "../protocol/topics.js";
import type { AckMessage, SignalMessage } from "../protocol/validate.js";
import { AckKind, type Envelope, FrameError, readEnvelope, readFrame, verifyMic } from "./frame.js";

/** 端末に割り当てない番号(0 = サーバー、65535 = 全員) */
const SERVER_NO = 0;
const ALL_NO = 0xffff;

export type GatewayDecode =
  | { ok: false; reason: string }
  | { ok: true; envelope: Envelope; kind: "message"; message: SignalMessage | AckMessage }
  | { ok: true; envelope: Envelope; kind: "ignored"; note: string };

export function decodeGateway(bytes: Uint8Array, key: Buffer): GatewayDecode {
  let envelope: Envelope;
  try {
    envelope = readEnvelope(bytes);
    readFrame(envelope.frame); // 長さ・版・種類を先に確かめる
  } catch (err) {
    if (err instanceof FrameError) return { ok: false, reason: `lora: ${err.message}` };
    throw err;
  }
  if (!verifyMic(envelope.frame, key)) return { ok: false, reason: "bad mic" };
  const f = readFrame(envelope.frame);

  switch (f.kind) {
    case "report": {
      if (f.src === SERVER_NO || f.src === ALL_NO) return { ok: false, reason: "lora: src" };
      const code = f.sos ? 1 : f.code;
      if (code < 1 || code > 31) return { ok: false, reason: "lora: code" };
      // 数量は区分番号 × 5。JSON の n と同じく 0〜255 に収まらなければ不正(区分外でも収まれば保存して印を付ける)
      const n = f.qty === 0 ? undefined : f.qty * 5;
      if (n !== undefined && n > 255) return { ok: false, reason: "lora: n out of range" };
      const message: SignalMessage = {
        type: "signal",
        src: formatDeviceId(f.src),
        seq: f.seq,
        ts: f.time === 0 ? null : f.time,
        code,
        pos: f.pos,
        via: "lora",
        ...(n !== undefined && { n }),
        ...(f.dir !== 0 && { dir: f.dir }),
      };
      return { ok: true, envelope, kind: "message", message };
    }
    case "ack": {
      // 指示を受け取った(種類 3)で、本部(src 0)の指示への確認だけをサーバーで扱う。
      // 近傍に届いた(1)・本部に届いた(2)は LoRa の中だけのもの
      if (f.ackKind !== AckKind.RECEIVED) return { ok: true, envelope, kind: "ignored", note: `ack kind ${f.ackKind}` };
      if (f.refSrc !== SERVER_NO) return { ok: true, envelope, kind: "ignored", note: "ack not for pc" };
      if (f.src === SERVER_NO || f.src === ALL_NO) return { ok: false, reason: "lora: src" };
      const message: AckMessage = {
        type: "ack",
        src: formatDeviceId(f.src),
        seq: f.seq,
        ts: null,
        ackKind: 3,
        // LoRa には mid が載らない。pc の連番(ref_seq)から、どの 1 通かを探す(INTERFACES §2.7)
        ackSrc: "pc",
        ackSeq: f.refSeq,
      };
      return { ok: true, envelope, kind: "message", message };
    }
    case "beacon":
      return { ok: true, envelope, kind: "ignored", note: "beacon" };
    case "instruct":
      // 下りのフレーム(本部 → 端末)。上りに来るのはおかしい
      return { ok: false, reason: "lora: instruct on uplink" };
  }
}
