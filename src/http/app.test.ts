// HTTP API のテスト(M2・M3)。Fastify の inject で、ブローカーも MySQL も使わずに流す(2026-11-06 作成)

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ChannelService } from "../server/channels.js";
import { PcSeq } from "../server/pcSeq.js";
import { Receiver } from "../server/receiver.js";
import { Sender } from "../server/sender.js";
import { MemoryStorage } from "../storage/memory.js";
import { VoiceService } from "../voice/service.js";
import { makeWav } from "../voice/wav.js";
import { buildApp } from "./app.js";

const T0 = Date.parse("2026-11-06T05:00:00.000Z"); // 日本時間 14:00
const quiet = { info() {}, warn() {}, error() {} };

async function setup(opts: { failPublish?: boolean } = {}) {
  const storage = new MemoryStorage();
  const now = () => new Date(T0);
  const pcSeq = new PcSeq(1);
  const published: { topic: string; body: Record<string, unknown> }[] = [];
  const publish = async (topic: string, payload: string) => {
    if (opts.failPublish) throw new Error("not connected");
    published.push({ topic, body: JSON.parse(payload) });
  };
  const receiver = new Receiver({ storage, pcSeq, publish, now, log: quiet });
  const sender = new Sender({ storage, pcSeq, publish, now, log: quiet });
  const app = await buildApp({
    storage,
    sender,
    isMqttConnected: () => !opts.failPublish,
    storageKind: "memory",
    webDir: null,
    dev: null,
    now,
  });
  const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, ...(payload !== undefined && { payload: payload as object }) });
    return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as unknown) : null };
  };
  /** 端末から上りが届いたことにする */
  const up = (type: string, src: string, over: Record<string, unknown>) =>
    receiver.handle(
      `reray/v1/up/${src}/${type}`,
      Buffer.from(JSON.stringify({ v: 1, type, src, seq: 1, ts: 1, ...over })),
    );
  return { storage, app, call, up, published, receiver };
}

// 型を付けずに中身を見るための道具
const get = (o: unknown, ...path: (string | number)[]): unknown =>
  path.reduce<unknown>((x, k) => (x as Record<string | number, unknown> | null)?.[k], o);

describe("端末の API", () => {
  it("登録・名前の変更・一覧。状態と最新の signal、未対応の SOS を返す", async () => {
    const { call, up } = await setup();
    assert.equal((await call("POST", "/api/devices", { id: "dev-001", owner: "山田" })).status, 201);
    assert.equal((await call("POST", "/api/devices", { id: "dev-001", owner: "x" })).status, 422);
    assert.equal((await call("POST", "/api/devices", { id: "dev-1" })).status, 400);
    assert.equal(get((await call("PUT", "/api/devices/dev-001", { owner: "山田太郎" })).body, "owner"), "山田太郎");
    assert.equal((await call("PUT", "/api/devices/dev-009", { owner: "x" })).status, 404);

    await up("status", "dev-001", { battery: 80, glass: true });
    await up("signal", "dev-001", { seq: 2, code: 1, pos: 3, via: "wifi" });

    const { body } = await call("GET", "/api/devices");
    assert.deepEqual(
      [
        get(body, 0, "id"), get(body, 0, "owner"), get(body, 0, "online"), get(body, 0, "battery"),
        get(body, 0, "glass"), get(body, 0, "position"), get(body, 0, "last_seen_at"),
      ],
      ["dev-001", "山田太郎", true, 80, true, { no: 3, name: "体育館前" }, "2026-11-06T14:00:00.000+09:00"],
    );
    assert.deepEqual(
      [get(body, 0, "last_signal", "code"), get(body, 0, "last_signal", "is_sos"), get(body, 0, "open_sos", "length")],
      [1, true, 1],
    );
    assert.equal((await call("GET", "/api/devices/dev-001")).status, 200);
    assert.equal((await call("GET", "/api/devices/dev-002")).status, 404);
  });

  it("受信で見つけた端末は registered = false", async () => {
    const { call, up } = await setup();
    await up("status", "dev-077", {});
    assert.equal(get((await call("GET", "/api/devices/dev-077")).body, "registered"), false);
  });
});

describe("送信と届き具合の API", () => {
  async function three() {
    const s = await setup();
    for (const id of ["dev-001", "dev-002", "dev-003"]) await s.call("POST", "/api/devices", { id });
    await s.up("status", "dev-001", { via: "wifi" });
    await s.up("status", "dev-002", { via: "lora" });
    return s;
  }

  it("一斉の自由な文: 201 で id。分母は送った時の経路ごと。ack で数が増える", async () => {
    const { call, up, published } = await three();
    const res = await call("POST", "/api/messages", { dst: "all", body: "北口に集合してください" });
    assert.equal(res.status, 201);
    const id = get(res.body, "id") as number;
    assert.equal(get(published.at(-1), "body", "mid"), id);

    await up("ack", "dev-001", { ack_mid: id });
    const m = (await call("GET", `/api/messages/${id}`)).body;
    assert.deepEqual(
      [get(m, "wifi"), get(m, "lora"), get(m, "offline")],
      [{ total: 1, acked: 1 }, { total: 1, acked: 0 }, { total: 1, acked: 0 }],
    );
    assert.deepEqual(get(m, "summary"), {
      total: 3, acked: 1, accepted: 0, declined: 0, waiting: 0, lora: 0, offline: 1, skipped: 1,
    });
    assert.deepEqual(
      (get(m, "devices") as unknown[]).map((d) => [get(d, "id"), get(d, "via_at_send"), get(d, "skipped")]),
      [["dev-001", "wifi", false], ["dev-002", "lora", true], ["dev-003", "offline", false]],
    );
  });

  it("指示コード: 文を作って送り、了解・できない を数える。最近送ったものに出る", async () => {
    const { call, up } = await three();
    const id = get((await call("POST", "/api/messages", { dst: "all", icode: 2, pos: 1 })).body, "id") as number;
    await up("ack", "dev-001", { ack_mid: id, ack_kind: 4 });
    await up("ack", "dev-002", { ack_mid: id, ack_kind: 5 });
    const m = (await call("GET", `/api/messages/${id}`)).body;
    assert.deepEqual(
      [get(m, "kind"), get(m, "body"), get(m, "requires_response"), get(m, "summary", "accepted"), get(m, "summary", "declined")],
      ["order", "本部テントに集合してください", true, 1, 1],
    );
    const list = (await call("GET", "/api/messages?limit=5")).body as unknown[];
    assert.equal(get(list, 0, "id"), id);
    assert.equal(get(list, 0, "devices"), undefined);
  });

  it("断る: 長すぎる本文・未登録の端末は 422、宛先なしは 400。流せなければ 503", async () => {
    const { call } = await three();
    assert.equal((await call("POST", "/api/messages", { dst: "all", body: "あ".repeat(41) })).status, 422);
    assert.equal((await call("POST", "/api/messages", { dst: "dev-099", body: "x" })).status, 422);
    assert.equal((await call("POST", "/api/messages", { body: "x" })).status, 400);
    assert.equal((await call("GET", "/api/messages/999")).status, 404);

    const broken = await setup({ failPublish: true });
    const res = await broken.call("POST", "/api/messages", { dst: "all", body: "x" });
    assert.deepEqual([res.status, get(res.body, "error")], [503, "mqtt_unavailable"]);
  });

  it("文字起こしの入口は、自由な文として送り source = transcript で残す", async () => {
    const { call, storage } = await three();
    const res = await call("POST", "/api/transcripts", { dst: "all", body: "各班、状況を確認", speaker: "本部" });
    assert.equal(res.status, 201);
    assert.equal((await storage.getMessage(get(res.body, "id") as number))?.source, "transcript");
  });
});

describe("記録と SOS の API", () => {
  it("記録を端末・種類・期間でしぼれる。SOS を対応済みにすると一覧から外れる", async () => {
    const { call, up } = await setup();
    await call("POST", "/api/devices", { id: "dev-001" });
    await up("signal", "dev-001", { seq: 1, code: 1 });
    await up("signal", "dev-001", { seq: 2, code: 6, n: 20 });
    await up("signal", "dev-002", { seq: 3, code: 2 });
    await call("POST", "/api/messages", { dst: "dev-001", body: "向かいます" });

    const types = async (q: string) =>
      ((await call("GET", `/api/logs${q}`)).body as unknown[]).map((x) => get(x, "type"));
    assert.equal((await types("")).length, 4);
    assert.deepEqual(await types("?device=dev-001&type=signal"), ["signal", "signal"]);
    assert.deepEqual(await types("?type=sos"), ["signal"]);
    assert.deepEqual(await types("?type=message"), ["message"]);
    assert.deepEqual(await types("?from=2026-11-07T00:00:00%2B09:00"), []);
    assert.equal((await call("GET", "/api/logs?type=status")).status, 400);

    const sos = (await call("GET", "/api/sos")).body as unknown[];
    assert.equal(sos.length, 1);
    const handled = await call("POST", `/api/signals/${String(get(sos, 0, "id"))}/handle`);
    assert.equal(get(handled.body, "handled_at"), "2026-11-06T14:00:00.000+09:00");
    assert.deepEqual((await call("GET", "/api/sos")).body, []);
    assert.equal((await call("POST", "/api/signals/999/handle")).status, 404);
  });
});

describe("一覧表の API", () => {
  it("ポジションを作る・変える・消す", async () => {
    const { call } = await setup();
    assert.equal((await call("POST", "/api/positions", { no: 9, name: "西門", place: "裏口", lat: 35.1 })).status, 201);
    assert.equal((await call("POST", "/api/positions", { no: 9, name: "x" })).status, 422);
    assert.equal((await call("POST", "/api/positions", { no: 0, name: "x" })).status, 400);
    assert.equal((await call("POST", "/api/positions", { no: 10, name: "" })).status, 422);
    assert.equal(get((await call("PUT", "/api/positions/9", { name: "西門2" })).body, "name"), "西門2");
    assert.equal((await call("PUT", "/api/positions/99", { name: "x" })).status, 404);
    assert.equal((await call("DELETE", "/api/positions/9")).status, 204);
    assert.equal((await call("DELETE", "/api/positions/9")).status, 404);
  });

  it("定型信号と指示コードの一覧。指示コードを足して変える", async () => {
    const { call } = await setup();
    assert.equal(get((await call("GET", "/api/signal-codes")).body, 0, "is_sos"), true);
    const c = { code: 99, name: "点呼", uses_position: false, text_without_pos: "点呼をとってください" };
    assert.equal((await call("POST", "/api/instruction-codes", c)).status, 201);
    assert.equal((await call("POST", "/api/instruction-codes", c)).status, 422);
    assert.equal((await call("POST", "/api/instruction-codes", { code: 98, name: "x", uses_position: true })).status, 422);
    const changed = (await call("PUT", "/api/instruction-codes/99", { ...c, requires_response: false })).body;
    assert.equal(get(changed, "requires_response"), false);
  });

  it("無い API は 404、壊れた JSON は 400(どちらも error と message を返す)", async () => {
    const { app, call } = await setup();
    const nf = await call("GET", "/api/nothing");
    assert.deepEqual([nf.status, get(nf.body, "error")], [404, "not_found"]);
    const res = await app.inject({ method: "POST", url: "/api/devices", headers: { "content-type": "application/json" }, payload: "{" });
    assert.equal(res.statusCode, 400);
    assert.ok(JSON.parse(res.body).message);
  });
});

describe("チャンネルの API【案】", () => {
  async function setupChannels() {
    const storage = new MemoryStorage();
    const now = () => new Date(T0);
    const pcSeq = new PcSeq(1);
    const published: { topic: string; body: Record<string, unknown> }[] = [];
    const publish = async (topic: string, payload: string) => {
      published.push({ topic, body: JSON.parse(payload) });
    };
    const channels = new ChannelService({ storage, pcSeq, publishRetained: publish, now, log: quiet });
    const sender = new Sender({ storage, pcSeq, publish, now, log: quiet, channels });
    const app = await buildApp({
      storage, sender, channels, isMqttConnected: () => true, storageKind: "memory", webDir: null, dev: null, now,
    });
    const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) => {
      const res = await app.inject({ method, url, ...(payload !== undefined && { payload: payload as object }) });
      return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as unknown) : null };
    };
    return { call, published };
  }

  it("端末を登録すると 1 対 1 ができ、設定が retain の口に流れる", async () => {
    const { call, published } = await setupChannels();
    await call("POST", "/api/devices", { id: "dev-001", owner: "山田" });
    assert.equal(published.at(-1)?.topic, "reray/v1/down/dev-001/config");
    const list = (await call("GET", "/api/channels")).body as unknown[];
    assert.deepEqual(
      list.map((c) => [get(c, "kind"), get(c, "name"), get(c, "members", 0, "owner")]),
      [["direct", "本部", "山田"]],
    );
    const config = (await call("GET", "/api/devices/dev-001/config")).body;
    assert.deepEqual(get(config, "channels", 0, "name"), "本部");
    assert.equal((await call("GET", "/api/devices/dev-009/config")).status, 404);
  });

  it("グループを作る・変える・消す。だめなときは 422 / 404", async () => {
    const { call } = await setupChannels();
    await call("POST", "/api/devices", { id: "dev-001", owner: "山田" });
    await call("POST", "/api/devices", { id: "dev-002", owner: "佐藤" });

    const made = await call("POST", "/api/channels", { name: "北班", members: ["dev-001", "dev-002"] });
    assert.equal(made.status, 201);
    const ch = get(made.body, "ch") as number;
    assert.deepEqual((get(made.body, "members") as unknown[]).map((m) => get(m, "id")), ["dev-001", "dev-002"]);

    const changed = await call("PUT", `/api/channels/${ch}`, { name: "北班A", members: ["dev-002"] });
    assert.deepEqual([get(changed.body, "name"), (get(changed.body, "members") as unknown[]).length], ["北班A", 1]);

    assert.equal((await call("POST", "/api/channels", { name: "x", members: ["dev-009"] })).status, 422);
    assert.equal((await call("POST", "/api/channels", { name: "長すぎる名前ですよね", members: [] })).status, 422);
    assert.equal((await call("PUT", "/api/channels/999", { name: "x", members: [] })).status, 404);

    assert.equal((await call("DELETE", `/api/channels/${ch}`)).status, 204);
    assert.equal((await call("DELETE", `/api/channels/${ch}`)).status, 404);
  });

  it("チャンネルあての文を送ると、記録に ch とチャンネル名が出る", async () => {
    const { call, published } = await setupChannels();
    await call("POST", "/api/devices", { id: "dev-001", owner: "山田" });
    const ch = get((await call("POST", "/api/channels", { name: "北班", members: ["dev-001"] })).body, "ch");
    const sent = await call("POST", "/api/messages", { ch, body: "集合" });
    assert.equal(sent.status, 201);
    assert.equal(published.at(-1)?.topic, "reray/v1/down/dev-001/text");

    const m = (await call("GET", `/api/messages/${get(sent.body, "id")}`)).body;
    assert.deepEqual([get(m, "ch"), get(m, "ch_name"), get(m, "from")], [ch, "北班", null]);
    assert.equal((await call("POST", "/api/messages", { ch: 999, body: "x" })).status, 422);
  });
});

describe("音声の API【案】", () => {
  async function setupVoice() {
    const storage = new MemoryStorage();
    const now = () => new Date(T0);
    const pcSeq = new PcSeq(1);
    const publish = async () => {};
    const channels = new ChannelService({ storage, pcSeq, publishRetained: publish, now, log: quiet });
    const sender = new Sender({ storage, pcSeq, publish, now, log: quiet, channels });
    const dir = await mkdtemp(join(tmpdir(), "reray-voice-api-"));
    const voice = new VoiceService({
      storage, sender, dir, now, log: quiet,
      transcriber: { label: "テスト", transcribe: async () => "了解しました" },
    });
    const app = await buildApp({
      storage, sender, channels, voice, isMqttConnected: () => true, storageKind: "memory", webDir: null, dev: null, now,
    });
    await storage.registerDevice("dev-001", "山田", new Date(T0));
    const g = await channels.createGroup("北班", ["dev-001"]);
    const post = (headers: Record<string, string>, payload: Buffer) =>
      app.inject({ method: "POST", url: "/api/voice", headers, payload });
    return { app, voice, post, ch: g.ch, dir };
  }

  it("WAV を受けて 202 {id}。文字起こしのあと、一覧に文字と音の場所が出る", async () => {
    const { app, voice, post, ch, dir } = await setupVoice();
    const wav = makeWav(2000);
    const headers = { "content-type": "audio/wav", "x-device": "dev-001", "x-channel": String(ch), "x-seq": "7" };
    const res = await post(headers, wav);
    assert.equal(res.statusCode, 202);
    const id = (JSON.parse(res.body) as { id: number }).id;
    // 送り直しは同じ id
    assert.deepEqual(JSON.parse((await post(headers, wav)).body), { id, duplicate: true });

    await voice.idle();
    const list = JSON.parse((await app.inject({ method: "GET", url: "/api/voice" })).body) as unknown[];
    assert.deepEqual(
      [get(list[0], "id"), get(list[0], "status"), get(list[0], "text"), get(list[0], "ch_name"), get(list[0], "owner")],
      [id, "done", "了解しました", "北班", "山田"],
    );
    const audio = await app.inject({ method: "GET", url: `/api/voice/${id}/audio` });
    assert.equal(audio.statusCode, 200);
    assert.equal(audio.headers["content-type"], "audio/wav");
    assert.equal(audio.rawPayload.length, wav.length);
    await rm(dir, { recursive: true, force: true });
  });

  it("形が違えば断る: Content-Type、大きすぎ、ヘッダ", async () => {
    const { post, ch, dir } = await setupVoice();
    const h = { "x-device": "dev-001", "x-channel": String(ch), "x-seq": "1" };
    assert.equal((await post({ ...h, "content-type": "application/octet-stream" }, makeWav(100))).statusCode, 415);
    assert.equal((await post({ ...h, "content-type": "audio/wav" }, Buffer.alloc(700 * 1024))).statusCode, 413);
    assert.equal((await post({ ...h, "content-type": "audio/wav", "x-seq": "x" }, makeWav(100))).statusCode, 400);
    assert.equal((await post({ ...h, "content-type": "audio/wav", "x-device": "dev-009" }, makeWav(100))).statusCode, 422);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("モードの API【案】", () => {
  it("POST /api/mode で全端末に流し、端末の今のモードは /api/devices の mode に出る", async () => {
    const { call, up, published } = await setup();
    const r = await call("POST", "/api/mode", { mode: "emergency" });
    assert.equal(r.status, 201);
    assert.equal(published.at(-1)?.topic, "reray/v1/down/all/mode");
    assert.equal((await call("POST", "/api/mode", { mode: "x" })).status, 422);

    await call("POST", "/api/devices", { id: "dev-001", owner: "山田" });
    await up("status", "dev-001", { mode: "emergency" });
    const list = (await call("GET", "/api/devices")).body as unknown[];
    assert.equal(get(list[0], "mode"), "emergency");
  });
});

describe("原本の API【案】", () => {
  it("捨てたもの(invalid)を理由つきで、端末ごとに引ける", async () => {
    const { call, receiver } = await setup();
    await receiver.handle("reray/v1/up/dev-001/signal", Buffer.from("{"));
    await receiver.handle("reray/v1/up/dev-002/signal", Buffer.from(JSON.stringify({ v: 2 })));
    const r = await call("GET", "/api/events?result=invalid&device=dev-001");
    assert.equal(r.status, 200);
    const list = r.body as unknown[];
    assert.deepEqual(
      list.map((e) => [get(e, "topic"), get(e, "result"), get(e, "note"), get(e, "payload")]),
      [["reray/v1/up/dev-001/signal", "invalid", "json", "{"]],
    );
    assert.equal((await call("GET", "/api/events?result=nope")).status, 400);
  });
});
