import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStorage } from "../storage/memory.js";
import { PcSeq } from "./pcSeq.js";
import { Receiver } from "./receiver.js";

const T0 = Date.parse("2026-11-06T00:00:00.000Z");
const quiet = { info() {}, warn() {}, error() {} };

/** 時計を手で進められる Receiver と、流したものの記録 */
function setup(opts: { failPublish?: boolean } = {}) {
  const storage = new MemoryStorage();
  const published: { topic: string; body: Record<string, unknown> }[] = [];
  let now = T0;
  const receiver = new Receiver({
    storage,
    pcSeq: new PcSeq(9),
    now: () => new Date(now),
    log: quiet,
    publish: async (topic, payload) => {
      if (opts.failPublish) throw new Error("broker down");
      published.push({ topic, body: JSON.parse(payload) });
    },
  });
  return {
    storage,
    receiver,
    published,
    advance(sec: number) {
      now += sec * 1000;
    },
  };
}

function signal(over: Record<string, unknown> = {}): [string, Uint8Array] {
  const body = { v: 1, type: "signal", src: "dev-001", seq: 42, ts: 1791849600, code: 6, pos: 3, n: 20, via: "wifi", ...over };
  return [`reray/v1/up/${body.src}/signal`, Buffer.from(JSON.stringify(body))];
}

describe("受信(signal)", () => {
  it("保存して、端末へ「本部に届いた」を返す", async () => {
    const { storage, receiver, published } = setup();
    const out = await receiver.handle(...signal());
    await receiver.drain();

    assert.equal(out.result, "accepted");
    assert.equal(storage.signals.length, 1);
    assert.equal(storage.signals[0]?.n, 20);
    assert.deepEqual(storage.signals[0]?.deviceTs, new Date(1791849600 * 1000));
    assert.deepEqual(storage.signals[0]?.receivedAt, new Date(T0));
    assert.deepEqual(published, [
      {
        topic: "reray/v1/down/dev-001/ack",
        body: { v: 1, type: "ack", src: "pc", seq: 9, ts: T0 / 1000, ack_src: "dev-001", ack_seq: 42 },
      },
    ]);
  });

  it("原本は、上りが accepted、下りが sent で残る", async () => {
    const { storage, receiver } = setup();
    await receiver.handle(...signal());
    await receiver.drain();
    assert.deepEqual(
      storage.events.map((e) => [e.direction, e.result, e.topic]),
      [
        ["up", "accepted", "reray/v1/up/dev-001/signal"],
        ["down", "sent", "reray/v1/down/dev-001/ack"],
      ],
    );
  });

  it("重複は保存しないが、「本部に届いた」は返す(端末が送り直しをやめられるように)", async () => {
    const { storage, receiver, published, advance } = setup();
    await receiver.handle(...signal({ via: "wifi" }));
    advance(3);
    const out = await receiver.handle(...signal({ via: "lora" }));
    await receiver.drain();

    assert.equal(out.result, "duplicate");
    assert.equal(storage.signals.length, 1);
    assert.equal(published.length, 2);
    // 2 回目の「本部に届いた」は pc の連番が進む
    assert.deepEqual(published.map((p) => p.body.seq), [9, 10]);
  });

  it("不正なものは invalid で原本だけ残し、「本部に届いた」は返さない", async () => {
    const { storage, receiver, published } = setup();
    const out = await receiver.handle("reray/v1/up/dev-001/signal", Buffer.from("{"));
    await receiver.drain();

    assert.deepEqual(out, { result: "invalid", note: "json" });
    assert.equal(storage.signals.length, 0);
    assert.equal(published.length, 0);
    assert.deepEqual(storage.events.map((e) => [e.result, e.note, e.payload]), [["invalid", "json", "{"]]);
  });

  it("流せなかった「本部に届いた」は failed で残る。受信の処理は止まらない", async () => {
    const { storage, receiver } = setup({ failPublish: true });
    const out = await receiver.handle(...signal());
    await receiver.drain();

    assert.equal(out.result, "accepted");
    const down = storage.events.find((e) => e.direction === "down");
    assert.equal(down?.result, "failed");
    assert.match(down?.note ?? "", /broker down/);
  });

  it("登録前の端末からの signal も保存し、registered = false の端末ができる", async () => {
    const { storage, receiver } = setup();
    await receiver.handle(...signal({ src: "dev-077" }));
    const d = await storage.getDevice("dev-077");
    assert.equal(d?.registered, false);
    assert.equal(d?.online, true);
  });
});

describe("受信(status・遺言・そのほか)", () => {
  it("status で電池とグラスを更新する", async () => {
    const { storage, receiver } = setup();
    const body = { v: 1, type: "status", src: "dev-001", seq: 43, ts: 1, battery: 80, glass: true };
    const out = await receiver.handle("reray/v1/up/dev-001/status", Buffer.from(JSON.stringify(body)));
    assert.equal(out.result, "accepted");
    const d = await storage.getDevice("dev-001");
    assert.equal(d?.battery, 80);
    assert.equal(d?.glass, true);
  });

  it("遺言で online = false。last_seen_at は変えない", async () => {
    const { storage, receiver, advance } = setup();
    await receiver.handle(...signal());
    advance(60);
    const will = { v: 1, type: "status", src: "dev-001", online: false };
    await receiver.handle("reray/v1/up/dev-001/status", Buffer.from(JSON.stringify(will)));

    const d = await storage.getDevice("dev-001");
    assert.equal(d?.online, false);
    assert.deepEqual(d?.lastSeenAt, new Date(T0));
  });

  it("出口の生渡しは、分解ができるまで原本(16 進)だけ残す", async () => {
    const { storage, receiver } = setup();
    const out = await receiver.handle("reray/v1/up/gw/dev-100/lora", Uint8Array.from([1, 0xab]));
    assert.equal(out.result, "ignored");
    assert.equal(storage.events[0]?.payload, "01ab");
  });
});

// 2026-11-06 追加: ack の対応づけ(M3)と 了解・できない【案】
describe("受信(ack)", () => {
  function ack(over: Record<string, unknown>): [string, Uint8Array] {
    const body = { v: 1, type: "ack", src: "dev-001", seq: 44, ts: 1, ...over };
    return [`reray/v1/up/${String(body.src)}/ack`, Buffer.from(JSON.stringify(body))];
  }

  async function sent(storage: MemoryStorage, seq: number, sentAt: number, targets: string[]) {
    return storage.createMessage(
      { seq, dst: "all", body: "x", kind: "free", source: "web", sentAt: new Date(sentAt) },
      targets.map((deviceId) => ({ deviceId, viaAtSend: "wifi" as const })),
    );
  }

  it("ack_mid で直接対応づける。2 回目は duplicate", async () => {
    const { storage, receiver } = setup();
    const m = await sent(storage, 7, T0, ["dev-001"]);
    assert.equal((await receiver.handle(...ack({ ack_mid: m.id }))).result, "accepted");
    assert.equal((await receiver.handle(...ack({ ack_mid: m.id }))).result, "duplicate");
    assert.deepEqual((await storage.getDeliveries(m.id))[0]?.ackedAt, new Date(T0));
  });

  it("ack_kind 4・5 は 了解・できない として残す", async () => {
    const { storage, receiver } = setup();
    const m = await sent(storage, 7, T0, ["dev-001", "dev-002"]);
    await receiver.handle(...ack({ ack_mid: m.id, ack_kind: 4 }));
    await receiver.handle(...ack({ src: "dev-002", ack_mid: m.id, ack_kind: 5 }));
    assert.deepEqual(
      (await storage.getDeliveries(m.id)).map((d) => d.response),
      ["accepted", "declined"],
    );
  });

  it("ack_seq だけなら、直近 10 分で同じ seq の、自分が宛先の 1 通に対応づける", async () => {
    const { storage, receiver } = setup();
    await sent(storage, 7, T0 - 11 * 60 * 1000, ["dev-001"]); // 10 分より前
    await sent(storage, 7, T0 - 60 * 1000, ["dev-002"]); // 宛先ではない
    const mine = await sent(storage, 7, T0 - 30 * 1000, ["dev-001"]);
    const out = await receiver.handle(...ack({ ack_src: "pc", ack_seq: 7 }));
    assert.equal(out.result, "accepted");
    assert.deepEqual((await storage.getDeliveries(mine.id))[0]?.ackedAt, new Date(T0));
  });

  it("ack_seq で 2 通以上あてはまれば、曖昧なので対応づけない", async () => {
    const { storage, receiver } = setup();
    await sent(storage, 7, T0 - 60 * 1000, ["dev-001"]);
    await sent(storage, 7, T0 - 30 * 1000, ["dev-001"]);
    assert.deepEqual(await receiver.handle(...ack({ ack_seq: 7 })), { result: "unmatched", note: "ambiguous ack_seq" });
  });

  it("無い mid・宛先でない端末は unmatched。それでも端末は「つながっている」になる", async () => {
    const { storage, receiver } = setup();
    const m = await sent(storage, 7, T0, ["dev-002"]);
    assert.equal((await receiver.handle(...ack({ ack_mid: 999 }))).result, "unmatched");
    assert.equal((await receiver.handle(...ack({ ack_mid: m.id }))).result, "unmatched");
    assert.equal((await storage.getDevice("dev-001"))?.online, true);
  });
});

describe("範囲外の印", () => {
  it("n は 5 きざみの 5〜100、dir は 1〜8。外れたら印を付けて保存する", async () => {
    const { storage, receiver } = setup();
    await receiver.handle(...signal({ seq: 1, n: 20, dir: 2 }));
    await receiver.handle(...signal({ seq: 2, n: 7 }));
    await receiver.handle(...signal({ seq: 3, n: undefined, dir: 9 }));
    assert.deepEqual(storage.signals.map((s) => s.outOfRange), [false, true, true]);
  });
});

describe("pc の連番", () => {
  it("65535 の次は 0。再起動したら最後の messages の seq の次から", async () => {
    const s = new PcSeq(65535);
    assert.deepEqual([s.next(), s.next()], [65535, 0]);

    const storage = new MemoryStorage();
    await storage.createMessage(
      { seq: 120, dst: "all", body: "x", kind: "free", source: "web", sentAt: new Date(T0) },
      [],
    );
    assert.equal((await PcSeq.fromStorage(storage)).next(), 121);
  });
});
