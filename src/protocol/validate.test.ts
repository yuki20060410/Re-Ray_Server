import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deviceNumber, parseUpTopic } from "./topics.js";
import { MAX_PAYLOAD_BYTES, parseUp } from "./validate.js";

const SIGNAL_TOPIC = "reray/v1/up/dev-001/signal";

function json(v: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(v));
}

function sig(over: Record<string, unknown> = {}) {
  return { v: 1, type: "signal", src: "dev-001", seq: 42, ts: 1791849600, code: 6, pos: 3, via: "wifi", ...over };
}

/** 不正のときの理由(正しければ "ok") */
function reason(topic: string, body: unknown): string {
  const r = parseUp(topic, json(body));
  return r.ok ? "ok" : r.reason;
}

describe("端末ID", () => {
  it("dev- と 3 桁以上。0 で埋めた形だけ", () => {
    assert.equal(deviceNumber("dev-001"), 1);
    assert.equal(deviceNumber("dev-65534"), 65534);
    assert.equal(deviceNumber("dev-1"), null);
    assert.equal(deviceNumber("dev-0001"), null);
    assert.equal(deviceNumber("dev-000"), null); // 0 はサーバー
    assert.equal(deviceNumber("dev-65535"), null); // 全員
    assert.equal(deviceNumber("pc"), null);
  });
});

describe("トピック", () => {
  it("端末のトピックと、出口の生渡しを読み分ける", () => {
    assert.deepEqual(parseUpTopic(SIGNAL_TOPIC), { kind: "device", deviceId: "dev-001", type: "signal" });
    assert.deepEqual(parseUpTopic("reray/v1/up/gw/dev-100/lora"), { kind: "gateway", gatewayId: "dev-100" });
    assert.equal(parseUpTopic("reray/v1/up/dev-001/text"), null);
    assert.equal(parseUpTopic("reray/v2/up/dev-001/signal"), null);
    assert.equal(parseUpTopic("reray/v1/down/dev-001/ack"), null);
  });
});

describe("signal", () => {
  it("正しい signal を読む。pos が無ければ 0、ts が 0 なら null", () => {
    const r = parseUp(SIGNAL_TOPIC, json(sig({ pos: undefined, ts: 0, n: 20, dir: 2 })));
    assert.ok(r.ok);
    assert.deepEqual(r.message, {
      type: "signal", src: "dev-001", seq: 42, ts: null, code: 6, pos: 0, n: 20, dir: 2, via: "wifi",
    });
  });

  it("n・dir は区分外・範囲外でも 0〜255 の整数なら通す。それ以外は捨てる", () => {
    assert.equal(reason(SIGNAL_TOPIC, sig({ n: 7, dir: 9 })), "ok");
    assert.equal(reason(SIGNAL_TOPIC, sig({ n: 256 })), "n out of range");
    assert.equal(reason(SIGNAL_TOPIC, sig({ n: 2.5 })), "n out of range");
    assert.equal(reason(SIGNAL_TOPIC, sig({ dir: "N" })), "dir out of range");
  });

  it("via が無ければ null。wifi / lora 以外は捨てる", () => {
    const r = parseUp(SIGNAL_TOPIC, json(sig({ via: undefined })));
    assert.ok(r.ok && r.message.type === "signal" && r.message.via === null);
    assert.equal(reason(SIGNAL_TOPIC, sig({ via: "sim" })), "via");
  });

  it("共通の項目の誤りは捨てる(INTERFACES §3)", () => {
    assert.equal(reason(SIGNAL_TOPIC, sig({ v: 2 })), "v!=1");
    assert.equal(reason(SIGNAL_TOPIC, sig({ type: "status" })), "type mismatch");
    assert.equal(reason(SIGNAL_TOPIC, sig({ src: "dev-002" })), "src mismatch");
    assert.equal(reason("reray/v1/up/dev-1/signal", sig({ src: "dev-1" })), "src");
    assert.equal(reason(SIGNAL_TOPIC, sig({ seq: 65536 })), "seq");
    assert.equal(reason(SIGNAL_TOPIC, sig({ seq: undefined })), "seq");
    assert.equal(reason(SIGNAL_TOPIC, sig({ ts: "now" })), "ts");
    assert.equal(reason(SIGNAL_TOPIC, sig({ code: 0 })), "code");
    assert.equal(reason(SIGNAL_TOPIC, sig({ code: 32 })), "code");
    assert.equal(reason(SIGNAL_TOPIC, sig({ pos: 256 })), "pos");
    assert.equal(reason(SIGNAL_TOPIC, [1, 2]), "not object");
  });

  it("壊れた JSON と、大きすぎる本文は捨てる", () => {
    const broken = parseUp(SIGNAL_TOPIC, Buffer.from("{"));
    assert.ok(!broken.ok && broken.reason === "json");
    const big = parseUp(SIGNAL_TOPIC, Buffer.alloc(MAX_PAYLOAD_BYTES + 1, 0x20));
    assert.ok(!big.ok && big.reason === "too large");
  });

  it("未知の項目は無視する", () => {
    assert.equal(reason(SIGNAL_TOPIC, sig({ x: { rssi: -80 } })), "ok");
  });
});

describe("status と遺言", () => {
  const topic = "reray/v1/up/dev-001/status";

  it("status の項目を読む。位置は両方そろったときだけ", () => {
    const r = parseUp(topic, json({ v: 1, type: "status", src: "dev-001", seq: 43, ts: 1, battery: 80, glass: true }));
    assert.ok(r.ok);
    assert.deepEqual(r.message, { type: "status", src: "dev-001", seq: 43, ts: 1, battery: 80, glass: true });
    assert.equal(reason(topic, { v: 1, type: "status", src: "dev-001", seq: 1, lat: 35 }), "lat/lon");
    assert.equal(reason(topic, { v: 1, type: "status", src: "dev-001", seq: 1, battery: 101 }), "battery");
  });

  it("遺言は seq と ts が無くても受け付ける", () => {
    const r = parseUp(topic, json({ v: 1, type: "status", src: "dev-001", online: false }));
    assert.ok(r.ok);
    assert.deepEqual(r.message, { type: "lastwill", src: "dev-001" });
  });
});

describe("ack", () => {
  const topic = "reray/v1/up/dev-001/ack";
  const base = { v: 1, type: "ack", src: "dev-001", seq: 44, ts: 1 };

  it("ack_mid の形と、ack_src + ack_seq の形の両方を受け付ける", () => {
    const a = parseUp(topic, json({ ...base, ack_mid: 12 }));
    assert.ok(a.ok && a.message.type === "ack" && a.message.ackMid === 12);
    const b = parseUp(topic, json({ ...base, ack_src: "pc", ack_seq: 7 }));
    assert.ok(b.ok && b.message.type === "ack" && b.message.ackSeq === 7 && b.message.ackSrc === "pc");
  });

  it("どの text への確認か分からないものは捨てる", () => {
    assert.equal(reason(topic, base), "ack target");
  });
});

describe("出口の生渡し", () => {
  it("バイナリのまま通す(分解は別)。出口ID の形は確かめる", () => {
    const bytes = Uint8Array.from([1, 0xff, 0xb0, 0x28, 0, 0, 0, 0]);
    const r = parseUp("reray/v1/up/gw/dev-100/lora", bytes);
    assert.ok(r.ok && r.message.type === "gateway" && r.message.gatewayId === "dev-100");
    const bad = parseUp("reray/v1/up/gw/gw1/lora", bytes);
    assert.ok(!bad.ok && bad.reason === "gateway id");
  });
});
