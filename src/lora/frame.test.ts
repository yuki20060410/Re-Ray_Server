// LoRa のフレームと出口の包みのテスト(2026-11-24 作成)
// 【注意】ここで使うフレームは、このファイルの encode* で作ったもの。ハード担当の実装と同じになるかは、
//   署名つきのテスト用データ(GATEWAY_RAW_FORMAT §5-2)が届いたら、それをここに足して確かめる

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeGateway } from "./decode.js";
import {
  computeMic,
  encodeAck,
  encodeBeacon,
  encodeInstruct,
  encodeReport,
  FrameError,
  parseHmacKey,
  readEnvelope,
  readFrame,
  verifyMic,
  wrapEnvelope,
} from "./frame.js";

const KEY = Buffer.from("00112233445566778899aabbccddeeff", "hex");

describe("LoRa のフレーム", () => {
  it("REPORT を作って読むと同じ値になる(17 バイト)", () => {
    const f = encodeReport({ src: 1, seq: 42, code: 6, pos: 3, qty: 4, dir: 2, time: 1795498805 }, KEY);
    assert.equal(f.length, 17);
    const r = readFrame(f);
    assert.ok(r.kind === "report");
    assert.deepEqual(
      [r.type, r.src, r.seq, r.code, r.pos, r.qty, r.dir, r.time, r.sos],
      [0, 1, 42, 6, 3, 4, 2, 1795498805, false],
    );
  });

  it("SOS は種類 1。ACK(14)・INSTRUCT(18)・BEACON(19)も読める", () => {
    const sos = readFrame(encodeReport({ src: 7, seq: 1, code: 1 }, KEY));
    assert.ok(sos.kind === "report" && sos.sos && sos.type === 1);
    const ack = readFrame(encodeAck({ src: 7, seq: 2, refSrc: 0, refSeq: 300, ackKind: 3 }, KEY));
    assert.ok(ack.kind === "ack" && ack.refSeq === 300 && ack.ackKind === 3);
    const ins = readFrame(encodeInstruct({ seq: 9, dst: 7, icode: 2, pos: 3 }, KEY));
    assert.ok(ins.kind === "instruct" && ins.icode === 2 && ins.dst === 7);
    const b = readFrame(encodeBeacon({ src: 7, seq: 3, lat: 35.68123, lon: 139.76543, battery: 80 }, KEY));
    assert.ok(b.kind === "beacon" && b.lat === 35.68123 && b.lon === 139.76543 && b.battery === 80);
  });

  it("署名は ttl を 0 にして計算する(中継で ttl が減っても合う)。中身を変えると合わない", () => {
    const f = encodeReport({ src: 1, seq: 42, code: 6, ttl: 3 }, KEY);
    assert.equal(verifyMic(f, KEY), true);
    const relayed = Buffer.from(f);
    relayed[0] = (relayed[0]! & ~0b111) | 1; // ttl 3 → 1
    assert.equal(verifyMic(relayed, KEY), true);
    const tampered = Buffer.from(f);
    tampered[5] = 99; // pos を書き換え
    assert.equal(verifyMic(tampered, KEY), false);
    assert.equal(verifyMic(f, Buffer.from("ffeeddccbbaa99887766554433221100", "hex")), false);
    assert.equal(computeMic(f.subarray(0, 13), KEY).length, 4);
  });

  it("長さ・版・種類が違えば FrameError", () => {
    const f = encodeReport({ src: 1, seq: 1, code: 6 }, KEY);
    assert.throws(() => readFrame(f.subarray(0, 16)), FrameError);
    const v2 = Buffer.from(f);
    v2[0] = (2 << 6) | (v2[0]! & 0x3f);
    assert.throws(() => readFrame(v2), /version/);
    const t7 = Buffer.from(f);
    t7[0] = (1 << 6) | (7 << 3);
    assert.throws(() => readFrame(t7), /type/);
  });

  it("出口の包み: rssi・snr(×4)・age_ms を読む。fmt が違えば FrameError", () => {
    const e = readEnvelope(wrapEnvelope(encodeReport({ src: 1, seq: 1, code: 6 }, KEY), { rssi: -112, snr: -7.5, ageMs: 4200 }));
    assert.deepEqual([e.rssi, e.snr, e.ageMs, e.frame.length], [-112, -7.5, 4200, 17]);
    const bad = wrapEnvelope(encodeReport({ src: 1, seq: 1, code: 6 }, KEY));
    bad[0] = 2;
    assert.throws(() => readEnvelope(bad), /fmt/);
  });

  it("鍵は 16 進(32 桁以上)。形が違えば起動を止める", () => {
    assert.equal(parseHmacKey(undefined), null);
    assert.equal(parseHmacKey(""), null);
    assert.equal(parseHmacKey("00112233445566778899aabbccddeeff")?.length, 16);
    assert.throws(() => parseHmacKey("short"));
    assert.throws(() => parseHmacKey("00112233445566778899aabbccddeef")); // 奇数桁
  });
});

describe("出口の生渡しを JSON と同じ形に直す", () => {
  it("REPORT → signal(n = 区分 × 5、dir、ts、via = lora)", () => {
    const d = decodeGateway(wrapEnvelope(encodeReport({ src: 1, seq: 42, code: 6, pos: 3, qty: 4, dir: 2, time: 1795498805 }, KEY)), KEY);
    assert.ok(d.ok && d.kind === "message");
    assert.deepEqual(d.message, {
      type: "signal", src: "dev-001", seq: 42, ts: 1795498805, code: 6, pos: 3, via: "lora", n: 20, dir: 2,
    });
  });

  it("数量・方角・時刻が無ければ項目なし。SOS は code = 1", () => {
    const d = decodeGateway(wrapEnvelope(encodeReport({ src: 5, seq: 1, code: 1 }, KEY)), KEY);
    assert.ok(d.ok && d.kind === "message" && d.message.type === "signal");
    assert.deepEqual([d.message.code, d.message.ts, "n" in d.message, "dir" in d.message], [1, null, false, false]);
  });

  it("ACK 種類 3(本部の指示を受け取った)→ ack(ack_seq = ref_seq)。種類 1・2 と BEACON は扱わない", () => {
    const a = decodeGateway(wrapEnvelope(encodeAck({ src: 5, seq: 9, refSrc: 0, refSeq: 300, ackKind: 3 }, KEY)), KEY);
    assert.ok(a.ok && a.kind === "message");
    assert.deepEqual(a.message, { type: "ack", src: "dev-005", seq: 9, ts: null, ackKind: 3, ackSrc: "pc", ackSeq: 300 });
    const near = decodeGateway(wrapEnvelope(encodeAck({ src: 5, seq: 9, refSrc: 0, refSeq: 1, ackKind: 1 }, KEY)), KEY);
    assert.ok(near.ok && near.kind === "ignored");
    const peer = decodeGateway(wrapEnvelope(encodeAck({ src: 5, seq: 9, refSrc: 7, refSeq: 1, ackKind: 3 }, KEY)), KEY);
    assert.ok(peer.ok && peer.kind === "ignored");
    const b = decodeGateway(wrapEnvelope(encodeBeacon({ src: 5, seq: 1, lat: 35, lon: 139, battery: 50 }, KEY)), KEY);
    assert.ok(b.ok && b.kind === "ignored");
  });

  it("不正: 署名が合わない、src が 0・65535、区分が大きすぎる、上りの INSTRUCT", () => {
    const reason = (frame: Buffer, key = KEY) => {
      const d = decodeGateway(wrapEnvelope(frame), key);
      return d.ok ? "ok" : d.reason;
    };
    assert.equal(reason(encodeReport({ src: 1, seq: 1, code: 6 }, KEY), Buffer.alloc(16, 1)), "bad mic");
    assert.equal(reason(encodeReport({ src: 0, seq: 1, code: 6 }, KEY)), "lora: src");
    assert.equal(reason(encodeReport({ src: 65535, seq: 1, code: 6 }, KEY)), "lora: src");
    assert.equal(reason(encodeReport({ src: 1, seq: 1, code: 6, qty: 52 }, KEY)), "lora: n out of range");
    assert.equal(reason(encodeReport({ src: 1, seq: 1, code: 6, qty: 21 }, KEY)), "ok"); // 区分外でも 255 以下なら保存(印)
    assert.equal(reason(encodeInstruct({ seq: 1, dst: 1, icode: 1, pos: 1 }, KEY)), "lora: instruct on uplink");
    assert.equal(decodeGateway(Buffer.from([1, 2, 3]), KEY).ok, false);
  });
});
