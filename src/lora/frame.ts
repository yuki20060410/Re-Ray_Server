// 出口の生渡し(reray/v1/up/gw/{出口ID}/lora)を分解する(GATEWAY_RAW_FORMAT、共通仕様/00_統合案 §4.4・§6.1)
//
// 包み(出口が付ける 8 バイト)+ LoRa のフレーム(端末が作る 14〜19 バイト)。すべてビッグエンディアン。
// 2026-11-24 作成【案】。**ハード担当の署名つきテスト用データ(GATEWAY_RAW_FORMAT §5-2)で、まだ答え合わせしていない。**
// 合わなかったら、下の「形の決まり」の定数と、読む関数だけを直す。
//
// 包み:   [0] fmt(=1)  [1-2] rssi(i16、dBm)  [3] snr(i8、dB×4)  [4-7] age_ms(u32)  [8-] フレーム
// ヘッダ: [0] 版(上位 2 ビット = 1)/ 種類(次の 3 ビット)/ ttl(下位 3 ビット)  [1-2] src(u16)  [3-4] seq(u16)
// 種類:   0 REPORT(17)、1 SOS(17)、2 INSTRUCT(18)、3 ACK(14)、4 BEACON(19)
// 署名:   HMAC-SHA256(鍵, MIC を除いたフレーム。ただし ttl の 3 ビットを 0 にする)の先頭 4 バイト = 最後の 4 バイト

import { createHmac, timingSafeEqual } from "node:crypto";

// ---- 形の決まり ----
export const ENVELOPE_FMT = 1;
export const ENVELOPE_BYTES = 8;
export const FRAME_VERSION = 1;
export const MIC_BYTES = 4;

export const FrameType = { REPORT: 0, SOS: 1, INSTRUCT: 2, ACK: 3, BEACON: 4 } as const;
export type FrameTypeName = keyof typeof FrameType;

/** 種類ごとのフレームの長さ(バイト、署名を含む) */
const FRAME_LENGTH: Record<number, number> = { 0: 17, 1: 17, 2: 18, 3: 14, 4: 19 };

/** ACK の種類(9 バイト目) */
export const AckKind = { NEAR: 1, HQ: 2, RECEIVED: 3 } as const;

export class FrameError extends Error {}

export interface Envelope {
  rssi: number;
  snr: number;
  ageMs: number;
  frame: Buffer;
}

interface Header {
  type: number;
  ttl: number;
  src: number;
  seq: number;
}

export type Frame =
  | (Header & {
      kind: "report";
      /** SOS(種類 1)か */
      sos: boolean;
      pos: number;
      /** 数量の区分番号(0 = 無し、1〜20) */
      qty: number;
      /** 方角(0 = 無し、1〜8) */
      dir: number;
      code: number;
      flags: number;
      /** UNIX 秒(0 = 時刻が合っていない) */
      time: number;
    })
  | (Header & { kind: "instruct"; dstType: number; dst: number; icode: number; pos: number; time: number })
  | (Header & { kind: "ack"; refSrc: number; refSeq: number; ackKind: number })
  | (Header & { kind: "beacon"; lat: number; lon: number; battery: number; role: number });

/** 包みを外す */
export function readEnvelope(buf: Uint8Array): Envelope {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < ENVELOPE_BYTES + 5) throw new FrameError("too short");
  if (b.readUInt8(0) !== ENVELOPE_FMT) throw new FrameError(`fmt ${b.readUInt8(0)}`);
  return {
    rssi: b.readInt16BE(1),
    snr: b.readInt8(3) / 4,
    ageMs: b.readUInt32BE(4),
    frame: b.subarray(ENVELOPE_BYTES),
  };
}

/** フレームを読む。長さ・版・種類が合わなければ FrameError。署名はここでは確かめない(verifyMic) */
export function readFrame(f: Buffer): Frame {
  if (f.length < 5) throw new FrameError("frame too short");
  const h0 = f.readUInt8(0);
  const version = h0 >> 6;
  const type = (h0 >> 3) & 0b111;
  if (version !== FRAME_VERSION) throw new FrameError(`version ${version}`);
  const len = FRAME_LENGTH[type];
  if (len === undefined) throw new FrameError(`type ${type}`);
  if (f.length !== len) throw new FrameError(`length ${f.length} (type ${type} is ${len})`);
  const header: Header = { type, ttl: h0 & 0b111, src: f.readUInt16BE(1), seq: f.readUInt16BE(3) };

  switch (type) {
    case FrameType.REPORT:
    case FrameType.SOS: {
      const flags = f.readUInt8(8);
      return {
        ...header,
        kind: "report",
        sos: type === FrameType.SOS,
        pos: f.readUInt8(5),
        qty: f.readUInt8(6),
        dir: f.readUInt8(7) & 0x0f,
        flags,
        code: flags >> 3,
        time: f.readUInt32BE(9),
      };
    }
    case FrameType.INSTRUCT:
      return {
        ...header,
        kind: "instruct",
        dstType: f.readUInt8(5),
        dst: f.readUInt16BE(6),
        icode: f.readUInt8(8),
        pos: f.readUInt8(9),
        time: f.readUInt32BE(10),
      };
    case FrameType.ACK:
      return { ...header, kind: "ack", refSrc: f.readUInt16BE(5), refSeq: f.readUInt16BE(7), ackKind: f.readUInt8(9) };
    default:
      return {
        ...header,
        kind: "beacon",
        lat: f.readInt32BE(5) / 1e5,
        lon: f.readInt32BE(9) / 1e5,
        battery: f.readUInt8(13),
        role: f.readUInt8(14),
      };
  }
}

/** 署名(MIC)を計算する。ttl は中継で変わるので 0 にして計算する */
export function computeMic(frameWithoutMic: Buffer, key: Buffer): Buffer {
  const data = Buffer.from(frameWithoutMic);
  data[0] = (data[0] ?? 0) & ~0b111;
  return createHmac("sha256", key).update(data).digest().subarray(0, MIC_BYTES);
}

/** 署名が合うか */
export function verifyMic(frame: Buffer, key: Buffer): boolean {
  if (frame.length <= MIC_BYTES) return false;
  const body = frame.subarray(0, frame.length - MIC_BYTES);
  const mic = frame.subarray(frame.length - MIC_BYTES);
  return timingSafeEqual(computeMic(body, key), mic);
}

/**
 * 鍵を読む(.env の RERAY_HMAC_KEY)。16 進の文字列(偶数桁、32 桁 = 16 バイト以上)。
 * 形が違えば throw(起動時に止める。間違った鍵で全部を「署名が合わない」にしないため)
 */
export function parseHmacKey(hex: string | undefined): Buffer | null {
  if (!hex) return null;
  const s = hex.trim();
  if (!/^(?:[0-9a-fA-F]{2}){16,}$/.test(s)) {
    throw new Error("RERAY_HMAC_KEY は 16 進の文字列(32 桁以上、偶数桁)で書いてください");
  }
  return Buffer.from(s, "hex");
}

// ---- テスト・疑似端末用: フレームを作る ----

function header(type: number, ttl: number, src: number, seq: number): Buffer {
  const b = Buffer.alloc(5);
  b.writeUInt8((FRAME_VERSION << 6) | (type << 3) | (ttl & 0b111), 0);
  b.writeUInt16BE(src, 1);
  b.writeUInt16BE(seq, 3);
  return b;
}

function sign(body: Buffer, key: Buffer): Buffer {
  return Buffer.concat([body, computeMic(body, key)]);
}

export function encodeReport(
  o: { src: number; seq: number; code: number; pos?: number; qty?: number; dir?: number; time?: number; sos?: boolean; ttl?: number },
  key: Buffer,
): Buffer {
  const sos = o.sos ?? o.code === 1;
  const body = Buffer.alloc(13);
  header(sos ? FrameType.SOS : FrameType.REPORT, o.ttl ?? 3, o.src, o.seq).copy(body, 0);
  body.writeUInt8(o.pos ?? 0, 5);
  body.writeUInt8(o.qty ?? 0, 6);
  body.writeUInt8((o.dir ?? 0) & 0x0f, 7);
  body.writeUInt8(((o.code & 0x1f) << 3) | (sos ? 1 : 0) | ((o.time ?? 0) > 0 ? 0b100 : 0), 8);
  body.writeUInt32BE(o.time ?? 0, 9);
  return sign(body, key);
}

export function encodeAck(o: { src: number; seq: number; refSrc: number; refSeq: number; ackKind: number; ttl?: number }, key: Buffer): Buffer {
  const body = Buffer.alloc(10);
  header(FrameType.ACK, o.ttl ?? 3, o.src, o.seq).copy(body, 0);
  body.writeUInt16BE(o.refSrc, 5);
  body.writeUInt16BE(o.refSeq, 7);
  body.writeUInt8(o.ackKind, 9);
  return sign(body, key);
}

export function encodeInstruct(o: { seq: number; dst: number; icode: number; pos: number; time?: number }, key: Buffer): Buffer {
  const body = Buffer.alloc(14);
  header(FrameType.INSTRUCT, 3, 0, o.seq).copy(body, 0);
  body.writeUInt8(o.dst === 0 ? 0 : 2, 5);
  body.writeUInt16BE(o.dst, 6);
  body.writeUInt8(o.icode, 8);
  body.writeUInt8(o.pos, 9);
  body.writeUInt32BE(o.time ?? 0, 10);
  return sign(body, key);
}

export function encodeBeacon(o: { src: number; seq: number; lat: number; lon: number; battery: number; role?: number }, key: Buffer): Buffer {
  const body = Buffer.alloc(15);
  header(FrameType.BEACON, 3, o.src, o.seq).copy(body, 0);
  body.writeInt32BE(Math.round(o.lat * 1e5), 5);
  body.writeInt32BE(Math.round(o.lon * 1e5), 9);
  body.writeUInt8(o.battery, 13);
  body.writeUInt8(o.role ?? 0, 14);
  return sign(body, key);
}

/** 出口の包みを付ける */
export function wrapEnvelope(frame: Buffer, o: { rssi?: number; snr?: number; ageMs?: number } = {}): Buffer {
  const b = Buffer.alloc(ENVELOPE_BYTES);
  b.writeUInt8(ENVELOPE_FMT, 0);
  b.writeInt16BE(o.rssi ?? -90, 1);
  b.writeInt8(Math.round((o.snr ?? 5) * 4), 3);
  b.writeUInt32BE(o.ageMs ?? 0, 4);
  return Buffer.concat([b, frame]);
}
