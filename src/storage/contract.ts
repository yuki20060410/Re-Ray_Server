// 保存の窓口の約束を確かめるテスト(どの実装にも同じものを流す)
//
// メモリ版は memory.test.ts から流す。MySQL 版を作ったら、同じように
// runStorageContract("mysql", () => 空の DB につないだ実装) を流して、全部通ることを確かめる。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NewSignal, Storage } from "./types.js";

const TEN_MIN = 10 * 60 * 1000;
const T0 = Date.parse("2026-11-06T00:00:00.000Z");

/** T0 から sec 秒後 */
function at(sec: number): Date {
  return new Date(T0 + sec * 1000);
}

function signal(over: Partial<NewSignal> = {}): NewSignal {
  return {
    deviceId: "dev-001",
    seq: 42,
    code: 6,
    pos: 3,
    n: 20,
    via: "wifi",
    deviceTs: null,
    receivedAt: at(0),
    ...over,
  };
}

export function runStorageContract(name: string, make: () => Promise<Storage>): void {
  describe(`保存の窓口(${name})`, () => {
    describe("定型信号", () => {
      it("保存すると、登録前の端末が registered = false で作られる", async () => {
        const s = await make();
        const r = await s.recordSignal(signal(), TEN_MIN);
        assert.equal(r.kind, "saved");

        const d = await s.getDevice("dev-001");
        assert.ok(d);
        assert.equal(d.registered, false);
        assert.equal(d.owner, null);
        assert.equal(d.online, true);
        assert.equal(d.via, "wifi");
        assert.equal(d.pos, 3);
        assert.deepEqual(d.lastSeenAt, at(0));
      });

      it("数量 n と方角 dir をそのまま残す。無い項目は無いまま", async () => {
        const s = await make();
        await s.recordSignal(signal({ seq: 1, n: 10, dir: 2 }), TEN_MIN);
        await s.recordSignal(signal({ seq: 2, n: undefined, receivedAt: at(1) }), TEN_MIN);

        const last = await s.getLastSignal("dev-001");
        assert.ok(last);
        assert.equal(last.seq, 2);
        assert.equal(last.n, undefined);
        assert.equal(last.dir, undefined);
      });

      it("10 分以内の同じ端末・同じ seq は重複。先に届いた方が残る", async () => {
        const s = await make();
        await s.recordSignal(signal({ via: "wifi" }), TEN_MIN);
        const r = await s.recordSignal(signal({ via: "lora", receivedAt: at(5) }), TEN_MIN);
        assert.equal(r.kind, "duplicate");

        const d = await s.getDevice("dev-001");
        assert.equal(d?.via, "wifi");
        assert.deepEqual(d?.lastSeenAt, at(0));
      });

      it("同じ seq でも、10 分を過ぎていれば別の signal(seq の一周)", async () => {
        const s = await make();
        await s.recordSignal(signal(), TEN_MIN);
        const r = await s.recordSignal(signal({ receivedAt: at(601) }), TEN_MIN);
        assert.equal(r.kind, "saved");
      });

      it("別の端末の同じ seq は重複ではない", async () => {
        const s = await make();
        await s.recordSignal(signal(), TEN_MIN);
        const r = await s.recordSignal(signal({ deviceId: "dev-002" }), TEN_MIN);
        assert.equal(r.kind, "saved");
      });

      it("同時に届いても 1 件だけ保存する", async () => {
        const s = await make();
        const rs = await Promise.all([
          s.recordSignal(signal({ via: "wifi" }), TEN_MIN),
          s.recordSignal(signal({ via: "lora" }), TEN_MIN),
          s.recordSignal(signal({ via: "lora" }), TEN_MIN),
        ]);
        assert.equal(rs.filter((r) => r.kind === "saved").length, 1);
      });

      it("古い signal が後から届いても、端末の今の値と最新の signal は巻き戻さない", async () => {
        const s = await make();
        await s.recordSignal(signal({ seq: 50, pos: 7, via: "wifi", receivedAt: at(100) }), TEN_MIN);
        // 出口に溜まっていた分(受信時刻 = サーバーの受信時刻 − age_ms で、前の時刻になる)
        await s.recordSignal(signal({ seq: 40, pos: 1, via: "lora", receivedAt: at(30) }), TEN_MIN);

        const d = await s.getDevice("dev-001");
        assert.equal(d?.pos, 7);
        assert.equal(d?.via, "wifi");
        assert.deepEqual(d?.lastSeenAt, at(100));
        assert.equal((await s.getLastSignal("dev-001"))?.seq, 50);
      });

      it("切れた端末に古い signal が後から届いても、つながったことにはしない", async () => {
        const s = await make();
        await s.recordSignal(signal({ seq: 50, receivedAt: at(100) }), TEN_MIN);
        await s.setOnline("dev-001", false);
        await s.recordSignal(signal({ seq: 40, via: "lora", receivedAt: at(30) }), TEN_MIN);
        assert.equal((await s.getDevice("dev-001"))?.online, false);
      });

      it("signal の無い端末の最新は null", async () => {
        const s = await make();
        assert.equal(await s.getLastSignal("dev-009"), null);
      });
    });

    describe("端末", () => {
      it("status の無い項目は前の値のまま", async () => {
        const s = await make();
        await s.recordStatus({ deviceId: "dev-001", receivedAt: at(0), battery: 80, glass: true });
        await s.recordStatus({ deviceId: "dev-001", receivedAt: at(30), glass: false });

        const d = await s.getDevice("dev-001");
        assert.equal(d?.battery, 80);
        assert.equal(d?.glass, false);
        assert.deepEqual(d?.lastSeenAt, at(30));
      });

      it("遺言・時間切れで online = false にしても、last_seen_at は変えない", async () => {
        const s = await make();
        await s.recordStatus({ deviceId: "dev-001", receivedAt: at(0) });
        await s.setOnline("dev-001", false);

        const d = await s.getDevice("dev-001");
        assert.equal(d?.online, false);
        assert.deepEqual(d?.lastSeenAt, at(0));
      });

      it("切れたあとに新しく届けば、つながったに戻る", async () => {
        const s = await make();
        await s.recordStatus({ deviceId: "dev-001", receivedAt: at(0) });
        await s.setOnline("dev-001", false);
        await s.touchDevice("dev-001", at(10));
        assert.equal((await s.getDevice("dev-001"))?.online, true);
      });

      it("知らない端末の setOnline は何もしない", async () => {
        const s = await make();
        await s.setOnline("dev-009", false);
        assert.equal(await s.getDevice("dev-009"), null);
      });

      it("受信で見つけた端末をあとから登録すると、状態を残したまま registered = true", async () => {
        const s = await make();
        await s.recordStatus({ deviceId: "dev-001", receivedAt: at(0), battery: 50 });
        const d = await s.registerDevice("dev-001", "山田", at(60));
        assert.equal(d.registered, true);
        assert.equal(d.owner, "山田");
        assert.equal(d.battery, 50);
        assert.deepEqual(d.createdAt, at(0));
      });

      it("持ち主の名前を変えられる。無い端末なら null", async () => {
        const s = await make();
        await s.registerDevice("dev-001", "山田", at(0));
        assert.equal((await s.updateOwner("dev-001", "鈴木"))?.owner, "鈴木");
        assert.equal(await s.updateOwner("dev-009", "鈴木"), null);
      });

      it("一覧は端末ID の順", async () => {
        const s = await make();
        await s.touchDevice("dev-002", at(0));
        await s.touchDevice("dev-001", at(0));
        assert.deepEqual((await s.listDevices()).map((d) => d.id), ["dev-001", "dev-002"]);
      });
    });

    describe("本部から送ったものと、届いた確認", () => {
      it("id(= mid)が返り、宛先と送った時の経路が残る", async () => {
        const s = await make();
        const m = await s.createMessage(
          { seq: 7, dst: "all", body: "北口に集合", kind: "free", source: "web", sentAt: at(0) },
          [
            { deviceId: "dev-001", viaAtSend: "wifi" },
            { deviceId: "dev-006", viaAtSend: "lora" },
          ],
        );
        assert.ok(m.id > 0);
        assert.equal(m.publishState, null);

        await s.setPublishState(m.id, "sent");
        assert.equal((await s.getMessage(m.id))?.publishState, "sent");

        const ds = await s.getDeliveries(m.id);
        assert.deepEqual(
          ds.map((d) => [d.deviceId, d.viaAtSend, d.ackedAt]),
          [
            ["dev-001", "wifi", null],
            ["dev-006", "lora", null],
          ],
        );
      });

      it("同じ 1 通・同じ端末の 2 回目の ack は保存しない(最初の時刻を残す)", async () => {
        const s = await make();
        const m = await s.createMessage(
          { seq: 7, dst: "dev-001", body: "待機", kind: "free", source: "web", sentAt: at(0) },
          [{ deviceId: "dev-001", viaAtSend: "wifi" }],
        );
        assert.equal((await s.recordAck(m.id, "dev-001", at(1))).kind, "saved");
        assert.equal((await s.recordAck(m.id, "dev-001", at(2))).kind, "duplicate");
        assert.deepEqual((await s.getDeliveries(m.id))[0]?.ackedAt, at(1));
      });

      it("seq で探すと、since より後のものが新しい順に返る", async () => {
        const s = await make();
        const base = { dst: "all", body: "x", kind: "free", source: "web" } as const;
        await s.createMessage({ ...base, seq: 7, sentAt: at(0) }, []);
        const b = await s.createMessage({ ...base, seq: 7, sentAt: at(700) }, []);
        await s.createMessage({ ...base, seq: 8, sentAt: at(710) }, []);

        const found = await s.findMessagesBySeq(7, at(100));
        assert.deepEqual(found.map((m) => m.id), [b.id]);
      });

      it("再起動したときの pc の連番は、最後に送った 1 通の seq の次から", async () => {
        const s = await make();
        assert.equal(await s.getLastMessageSeq(), null);
        const base = { dst: "all", body: "x", kind: "free", source: "web" } as const;
        await s.createMessage({ ...base, seq: 65535, sentAt: at(0) }, []);
        await s.createMessage({ ...base, seq: 0, sentAt: at(1) }, []);
        assert.equal(await s.getLastMessageSeq(), 0);
      });
    });

    describe("原本", () => {
      it("書いたあとで結果と理由を変えられる", async () => {
        const s = await make();
        const id = await s.saveEvent({
          at: at(0),
          direction: "up",
          topic: "reray/v1/up/dev-001/signal",
          payload: "{",
          result: "pending",
        });
        await s.setEventResult(id, "invalid", "json");
        // 原本を読む窓口はまだ無い(/api/logs を作るときに足す)。ここでは落ちないことだけ確かめる
        assert.ok(id > 0);
      });
    });
  });
}
