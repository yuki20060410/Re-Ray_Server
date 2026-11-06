// 上りの JSON を確かめて、サーバーで扱う形に直す(INTERFACES §2・§3、FIELDS §1)
//
// 不正なものは理由(events.note に入れる短い英語)を付けて返す。サーバーは捨てるだけで、止まらない。
// 未知の項目は無視する(原本には残る)。

import type { Via } from "../storage/types.js";
import { deviceNumber, parseUpTopic, type UpType } from "./topics.js";

/** これを超える本文は捨てる(DATAFLOW §8.1) */
export const MAX_PAYLOAD_BYTES = 4096;

export interface SignalMessage {
  type: "signal";
  src: string;
  seq: number;
  /** UNIX 秒。無い・0(未同期)なら null */
  ts: number | null;
  code: number;
  pos: number;
  n?: number;
  dir?: number;
  via: Via | null;
}

export interface StatusMessage {
  type: "status";
  src: string;
  seq: number;
  ts: number | null;
  battery?: number;
  glass?: boolean;
  via?: Via;
  lat?: number;
  lon?: number;
}

/** 遺言(ブローカーが代わりに流す。seq と ts が無い) */
export interface LastWillMessage {
  type: "lastwill";
  src: string;
}

export interface AckMessage {
  type: "ack";
  src: string;
  seq: number;
  ts: number | null;
  /** 【修正案】の形。あればこちらを使う */
  ackMid?: number;
  /** 現行のたたき台の形 */
  ackSrc?: string;
  ackSeq?: number;
}

/** 出口の生渡し。中身の分解は lora の処理で行う */
export interface GatewayFrame {
  type: "gateway";
  gatewayId: string;
  bytes: Uint8Array;
}

export type UpMessage = SignalMessage | StatusMessage | LastWillMessage | AckMessage | GatewayFrame;

export type ParseResult = { ok: true; message: UpMessage } | { ok: false; reason: string };

export function parseUp(topic: string, payload: Uint8Array): ParseResult {
  const t = parseUpTopic(topic);
  if (!t) return bad("topic");
  if (payload.byteLength > MAX_PAYLOAD_BYTES) return bad("too large");

  if (t.kind === "gateway") {
    if (deviceNumber(t.gatewayId) === null) return bad("gateway id");
    return { ok: true, message: { type: "gateway", gatewayId: t.gatewayId, bytes: payload } };
  }

  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(payload).toString("utf8"));
  } catch {
    return bad("json");
  }
  if (!isObject(body)) return bad("not object");
  if (body.v !== 1) return bad("v!=1");
  if (body.type !== t.type) return bad("type mismatch");
  if (typeof body.src !== "string" || deviceNumber(body.src) === null) return bad("src");
  if (body.src !== t.deviceId) return bad("src mismatch");

  // 遺言だけは seq と ts が無い
  if (t.type === "status" && body.online === false) {
    return { ok: true, message: { type: "lastwill", src: body.src } };
  }

  if (!isInt(body.seq, 0, 65535)) return bad("seq");
  const ts = readTs(body.ts);
  if (ts === undefined) return bad("ts");

  return parseBody(t.type, body, body.src, body.seq, ts);
}

function parseBody(
  type: UpType,
  body: Record<string, unknown>,
  src: string,
  seq: number,
  ts: number | null,
): ParseResult {
  switch (type) {
    case "signal": {
      if (!isInt(body.code, 1, 31)) return bad("code");
      const pos = body.pos === undefined ? 0 : body.pos;
      if (!isInt(pos, 0, 255)) return bad("pos");
      // n と dir は区分外・範囲外でも、0〜255 の整数なら保存する(画面で印を付ける。SIGNAL_FORMAT §7 #2)
      if (body.n !== undefined && !isInt(body.n, 0, 255)) return bad("n out of range");
      if (body.dir !== undefined && !isInt(body.dir, 0, 255)) return bad("dir out of range");
      const via = readVia(body.via);
      if (via === undefined) return bad("via");
      const message: SignalMessage = { type: "signal", src, seq, ts, code: body.code, pos, via };
      if (body.n !== undefined) message.n = body.n;
      if (body.dir !== undefined) message.dir = body.dir;
      return { ok: true, message };
    }
    case "status": {
      const message: StatusMessage = { type: "status", src, seq, ts };
      if (body.battery !== undefined) {
        if (!isInt(body.battery, 0, 100)) return bad("battery");
        message.battery = body.battery;
      }
      if (body.glass !== undefined) {
        if (typeof body.glass !== "boolean") return bad("glass");
        message.glass = body.glass;
      }
      if (body.via !== undefined) {
        const via = readVia(body.via);
        if (!via) return bad("via");
        message.via = via;
      }
      // 位置は両方そろっているときだけ使う
      if (body.lat !== undefined || body.lon !== undefined) {
        if (!isNum(body.lat, -90, 90) || !isNum(body.lon, -180, 180)) return bad("lat/lon");
        message.lat = body.lat;
        message.lon = body.lon;
      }
      return { ok: true, message };
    }
    case "ack": {
      const message: AckMessage = { type: "ack", src, seq, ts };
      if (body.ack_mid !== undefined) {
        if (!isInt(body.ack_mid, 1, Number.MAX_SAFE_INTEGER)) return bad("ack_mid");
        message.ackMid = body.ack_mid;
      }
      if (body.ack_seq !== undefined) {
        if (!isInt(body.ack_seq, 0, 65535)) return bad("ack_seq");
        message.ackSeq = body.ack_seq;
        if (typeof body.ack_src === "string") message.ackSrc = body.ack_src;
      }
      if (message.ackMid === undefined && message.ackSeq === undefined) return bad("ack target");
      return { ok: true, message };
    }
  }
}

// ---- 小さな道具 ----

function bad(reason: string): ParseResult {
  return { ok: false, reason };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isInt(v: unknown, min: number, max: number): v is number {
  return Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
}

function isNum(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}

/** 無ければ null、0(未同期)も null。数でなければ undefined(不正) */
function readTs(v: unknown): number | null | undefined {
  if (v === undefined || v === 0) return null;
  return isInt(v, 0, 0xffffffff) ? v : undefined;
}

/** 無ければ null。wifi / lora 以外は undefined(不正) */
function readVia(v: unknown): Via | null | undefined {
  if (v === undefined) return null;
  return v === "wifi" || v === "lora" ? v : undefined;
}
