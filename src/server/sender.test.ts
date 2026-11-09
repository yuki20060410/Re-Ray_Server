// 送信(M3)のテスト。ブローカーなしで、流したものを記録して確かめる(2026-11-06 作成)

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStorage } from "../storage/memory.js";
import { PcSeq } from "./pcSeq.js";
import { BODY_MAX, Sender, SendError } from "./sender.js";

const T0 = Date.parse("2026-11-06T00:00:00.000Z");
const quiet = { info() {}, warn() {}, error() {} };

async function setup(opts: { failPublish?: boolean } = {}) {
  const storage = new MemoryStorage();
  const published: { topic: string; body: Record<string, unknown> }[] = [];
  const sender = new Sender({
    storage,
    pcSeq: new PcSeq(7),
    now: () => new Date(T0),
    log: quiet,
    publish: async (topic, payload) => {
      if (opts.failPublish) throw new Error("not connected");
      published.push({ topic, body: JSON.parse(payload) });
    },
  });
  // dev-001: Wi-Fi、dev-002: LoRa、dev-003: 切れている、dev-004: 受信で見つけただけ(未登録)
  await storage.registerDevice("dev-001", "山田", new Date(T0));
  await storage.recordStatus({ deviceId: "dev-001", receivedAt: new Date(T0), via: "wifi" });
  await storage.registerDevice("dev-002", "佐藤", new Date(T0));
  await storage.recordStatus({ deviceId: "dev-002", receivedAt: new Date(T0), via: "lora" });
  await storage.registerDevice("dev-003", "鈴木", new Date(T0));
  await storage.touchDevice("dev-004", new Date(T0));
  return { storage, sender, published };
}

async function rejects(p: Promise<unknown>, status: number, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof SendError && e.status === status && e.code === code);
}

describe("送信", () => {
  it("一斉: 保存してから down/all/text に mid を付けて流す。宛先と経路が残る", async () => {
    const { storage, sender, published } = await setup();
    const m = await sender.send({ dst: "all", kind: "free", body: " 北口に集合してください " });

    assert.equal(m.publishState, "sent");
    assert.deepEqual(published, [
      {
        topic: "reray/v1/down/all/text",
        body: { v: 1, type: "text", src: "pc", dst: "all", seq: 7, mid: m.id, ts: T0 / 1000, body: "北口に集合してください" },
      },
    ]);
    assert.deepEqual(
      (await storage.getDeliveries(m.id)).map((d) => [d.deviceId, d.viaAtSend, d.skipped]),
      [
        ["dev-001", "wifi", false],
        ["dev-002", "lora", true], // 自由な文は LoRa では運ばない
        ["dev-003", "offline", false],
        ["dev-004", "wifi", false],
      ],
    );
    assert.equal(storage.events.at(-1)?.result, "sent");
  });

  it("個別の指示コード: 文を作り、icode と pos を付けて down/{id}/text に流す。LoRa の端末も分母に入る", async () => {
    const { storage, sender, published } = await setup();
    const m = await sender.send({ dst: "dev-002", kind: "order", icode: 1, pos: 3 });
    assert.equal(published[0]?.topic, "reray/v1/down/dev-002/text");
    assert.deepEqual(
      [published[0]?.body.icode, published[0]?.body.pos, published[0]?.body.body],
      [1, 3, "体育館前へ移動してください"],
    );
    assert.deepEqual((await storage.getDeliveries(m.id)).map((d) => [d.viaAtSend, d.skipped]), [["lora", false]]);
  });

  it("ポジションを使わない指示は pos = 0。表に無いポジションは番号のまま文にする", async () => {
    const { sender, published } = await setup();
    await sender.send({ dst: "all", kind: "order", icode: 3, pos: 9 });
    await sender.send({ dst: "all", kind: "order", icode: 1, pos: 200 });
    assert.deepEqual(
      published.map((p) => [p.body.pos, p.body.body]),
      [
        [0, "その場で待機してください"],
        [200, "ポジション200へ移動してください"],
      ],
    );
  });

  it("文字起こしは自由な文として送り、source = transcript で残す", async () => {
    const { storage, sender } = await setup();
    const m = await sender.send({ dst: "all", kind: "free", body: "各班、状況を確認", source: "transcript" });
    assert.equal((await storage.getMessage(m.id))?.source, "transcript");
  });

  it("確かめて断る: 空・長すぎる本文、未登録の端末、形の違う宛先、一覧に無い指示コード、ポジションなし", async () => {
    const { sender, published } = await setup();
    await rejects(sender.send({ dst: "all", kind: "free", body: "  " }), 422, "empty_body");
    await rejects(sender.send({ dst: "all", kind: "free", body: "あ".repeat(BODY_MAX + 1) }), 422, "body_too_long");
    await sender.send({ dst: "all", kind: "free", body: "あ".repeat(BODY_MAX) }); // ちょうどは送れる
    await rejects(sender.send({ dst: "dev-004", kind: "free", body: "x" }), 422, "unknown_device");
    await rejects(sender.send({ dst: "dev-099", kind: "free", body: "x" }), 422, "unknown_device");
    await rejects(sender.send({ dst: "dev-1", kind: "free", body: "x" }), 400, "bad_dst");
    await rejects(sender.send({ dst: "all", kind: "order", icode: 250, pos: 1 }), 422, "unknown_icode");
    await rejects(sender.send({ dst: "all", kind: "order", icode: 1, pos: 0 }), 422, "bad_pos");
    assert.equal(published.length, 1);
  });

  it("流せなければ 503。保存した 1 通は failed で残る", async () => {
    const { storage, sender } = await setup({ failPublish: true });
    await assert.rejects(sender.send({ dst: "all", kind: "free", body: "x" }), (e: unknown) => {
      assert.ok(e instanceof SendError);
      assert.equal(e.status, 503);
      assert.ok(e.messageId);
      return true;
    });
    const [m] = await storage.listMessages({ limit: 1 });
    assert.equal(m?.publishState, "failed");
    assert.equal(storage.events.at(-1)?.result, "failed");
  });
});
