// 保存の窓口の約束を確かめるテスト(どの実装にも同じものを流す)
//
// メモリ版は memory.test.ts、MySQL 版は mysql.test.ts から流す。
// make() は、毎回「空の記録 + 一覧表の仮の中身(seed.ts と 02_seed.sql)」の実装を返すこと。
// 2026-11-06: 窓口に足したもの(一覧表・SOS の対応済み・了解/できない・記録の検索・markOffline)の約束を足した

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NewMessage, NewSignal, Storage } from "./types.js";

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

function message(over: Partial<NewMessage> = {}): NewMessage {
  return { seq: 7, dst: "all", body: "北口に集合", kind: "free", source: "web", sentAt: at(0), ...over };
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
        assert.deepEqual(d.createdAt, at(0));
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

      it("保存した signal は、送った項目と範囲外の印をそのまま返す。対応済みはまだ null", async () => {
        const s = await make();
        const ts = new Date(1791849600 * 1000);
        const r = await s.recordSignal(
          signal({ seq: 9, code: 9, pos: 4, n: 7, dir: 12, via: "lora", deviceTs: ts, outOfRange: true }),
          TEN_MIN,
        );
        assert.equal(r.kind, "saved");
        const got = r.kind === "saved" ? await s.getSignal(r.signal.id) : null;
        assert.ok(got);
        assert.deepEqual(
          [got.deviceId, got.seq, got.code, got.pos, got.n, got.dir, got.via, got.outOfRange, got.handledAt],
          ["dev-001", 9, 9, 4, 7, 12, "lora", true, null],
        );
        assert.deepEqual(got.deviceTs, ts);
        assert.deepEqual(got.receivedAt, at(0));
      });

      it("経路の分からない signal も保存できる(via = null)", async () => {
        const s = await make();
        const r = await s.recordSignal(signal({ via: null }), TEN_MIN);
        assert.equal(r.kind, "saved");
        assert.equal((await s.getLastSignal("dev-001"))?.via, null);
      });

      it("ポジションや定型信号の一覧に無い番号でも保存する(INTERFACES §2.5)", async () => {
        const s = await make();
        const r = await s.recordSignal(signal({ code: 31, pos: 250 }), TEN_MIN);
        assert.equal(r.kind, "saved");
        assert.equal((await s.getDevice("dev-001"))?.pos, 250);
      });

      it("pos = 0(場所なし)の signal が最新なら、端末の今のポジションは null", async () => {
        const s = await make();
        await s.recordSignal(signal({ seq: 1, pos: 3 }), TEN_MIN);
        await s.recordSignal(signal({ seq: 2, pos: 0, receivedAt: at(1) }), TEN_MIN);
        assert.equal((await s.getDevice("dev-001"))?.pos, null);
        assert.equal((await s.getLastSignal("dev-001"))?.pos, 0);
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

      it("同時に届いても 1 件だけ保存する(登録前の端末でも)", async () => {
        const s = await make();
        const rs = await Promise.all([
          s.recordSignal(signal({ via: "wifi" }), TEN_MIN),
          s.recordSignal(signal({ via: "lora" }), TEN_MIN),
          s.recordSignal(signal({ via: "lora" }), TEN_MIN),
        ]);
        assert.equal(rs.filter((r) => r.kind === "saved").length, 1);
        assert.equal(rs.filter((r) => r.kind === "duplicate").length, 2);
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
        await s.markOffline("dev-001", "lastwill", at(110));
        await s.recordSignal(signal({ seq: 40, via: "lora", receivedAt: at(30) }), TEN_MIN);
        assert.equal((await s.getDevice("dev-001"))?.online, false);
      });

      it("signal の無い端末の最新は null。まとめて引くと、signal のある端末だけ入る", async () => {
        const s = await make();
        assert.equal(await s.getLastSignal("dev-009"), null);
        await s.recordSignal(signal({ seq: 1 }), TEN_MIN);
        await s.recordSignal(signal({ seq: 2, receivedAt: at(1) }), TEN_MIN);
        await s.touchDevice("dev-002", at(0));
        const m = await s.getLastSignals(["dev-001", "dev-002", "dev-009"]);
        assert.deepEqual([...m.keys()], ["dev-001"]);
        assert.equal(m.get("dev-001")?.seq, 2);
        assert.equal((await s.getLastSignals([])).size, 0);
      });

      it("無い signal を引くと null", async () => {
        const s = await make();
        assert.equal(await s.getSignal(999999), null);
        assert.equal(await s.handleSignal(999999, at(0)), null);
      });
    });

    describe("記録の検索と、SOS の対応済み", () => {
      async function three(s: Storage) {
        await s.recordSignal(signal({ seq: 1, code: 1, receivedAt: at(0) }), TEN_MIN);
        await s.recordSignal(signal({ seq: 2, code: 6, receivedAt: at(60) }), TEN_MIN);
        await s.recordSignal(signal({ deviceId: "dev-002", seq: 3, code: 1, receivedAt: at(120) }), TEN_MIN);
      }

      it("新しい順。端末・番号・期間・件数でしぼれる", async () => {
        const s = await make();
        await three(s);
        const seqs = async (f: Parameters<Storage["listSignals"]>[0]) =>
          (await s.listSignals(f)).map((x) => x.seq);
        assert.deepEqual(await seqs({ limit: 10 }), [3, 2, 1]);
        assert.deepEqual(await seqs({ deviceId: "dev-001", limit: 10 }), [2, 1]);
        assert.deepEqual(await seqs({ codes: [1], limit: 10 }), [3, 1]);
        assert.deepEqual(await seqs({ from: at(60), to: at(120), limit: 10 }), [2]);
        assert.deepEqual(await seqs({ limit: 2 }), [3, 2]);
      });

      it("対応済みにすると、未対応だけの検索から外れる。2 回目は最初の時刻のまま", async () => {
        const s = await make();
        await three(s);
        const [first] = await s.listSignals({ codes: [1], limit: 1 });
        assert.ok(first);
        assert.deepEqual((await s.handleSignal(first.id, at(200)))?.handledAt, at(200));
        assert.deepEqual((await s.handleSignal(first.id, at(300)))?.handledAt, at(200));
        assert.deepEqual(
          (await s.listSignals({ codes: [1], unhandledOnly: true, limit: 10 })).map((x) => x.seq),
          [1],
        );
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

      it("status の経路と位置を残す。電池・グラスが一度も届いていなければ null", async () => {
        const s = await make();
        await s.recordStatus({ deviceId: "dev-001", receivedAt: at(0), via: "lora", lat: 35.6812, lon: 139.7671 });
        const d = await s.getDevice("dev-001");
        assert.deepEqual([d?.via, d?.lat, d?.lon, d?.battery, d?.glass], ["lora", 35.6812, 139.7671, null, null]);
      });

      it("遺言・時間切れで online = false にしても、last_seen_at は変えない", async () => {
        const s = await make();
        await s.recordStatus({ deviceId: "dev-001", receivedAt: at(0) });
        assert.equal(await s.markOffline("dev-001", "lastwill", at(5)), true);

        const d = await s.getDevice("dev-001");
        assert.equal(d?.online, false);
        assert.deepEqual(d?.lastSeenAt, at(0));
        // もう切れているので、2 回目は何も変えない
        assert.equal(await s.markOffline("dev-001", "timeout", at(100)), false);
      });

      it("seenBefore より後に届いていれば、時間切れにしない", async () => {
        const s = await make();
        await s.recordStatus({ deviceId: "dev-001", receivedAt: at(100) });
        assert.equal(await s.markOffline("dev-001", "timeout", at(200), at(100)), false);
        assert.equal((await s.getDevice("dev-001"))?.online, true);
        assert.equal(await s.markOffline("dev-001", "timeout", at(200), at(101)), true);
      });

      it("切れたあとに新しく届けば、つながったに戻る", async () => {
        const s = await make();
        await s.recordStatus({ deviceId: "dev-001", receivedAt: at(0) });
        await s.markOffline("dev-001", "lastwill", at(5));
        await s.touchDevice("dev-001", at(10));
        assert.equal((await s.getDevice("dev-001"))?.online, true);
      });

      it("知らない端末の markOffline は何もしない", async () => {
        const s = await make();
        assert.equal(await s.markOffline("dev-009", "lastwill", at(0)), false);
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

      it("登録だけした端末は、つながっていない", async () => {
        const s = await make();
        const d = await s.registerDevice("dev-001", null, at(0));
        assert.deepEqual([d.registered, d.online, d.lastSeenAt, d.owner], [true, false, null, null]);
      });

      it("持ち主の名前を変えられる。無い端末なら null", async () => {
        const s = await make();
        await s.registerDevice("dev-001", "山田", at(0));
        assert.equal((await s.updateOwner("dev-001", "鈴木"))?.owner, "鈴木");
        assert.equal(await s.updateOwner("dev-009", "鈴木"), null);
      });

      it("一覧は端末ID の番号の順", async () => {
        const s = await make();
        await s.touchDevice("dev-1000", at(0));
        await s.touchDevice("dev-002", at(0));
        await s.touchDevice("dev-999", at(0));
        await s.touchDevice("dev-001", at(0));
        assert.deepEqual(
          (await s.listDevices()).map((d) => d.id),
          ["dev-001", "dev-002", "dev-999", "dev-1000"],
        );
      });
    });

    describe("一覧表", () => {
      it("ポジションを作る・変える・消す。同じ番号は作れない", async () => {
        const s = await make();
        const before = (await s.listPositions()).length;
        const p = { no: 200, name: "西門", place: "裏口", lat: 35.5, lon: 139.5 };
        assert.deepEqual((await s.createPosition(p, at(0)))?.name, "西門");
        assert.equal(await s.createPosition(p, at(1)), null);

        const changed = await s.updatePosition({ ...p, name: "西門(仮)", place: null, lat: null, lon: null }, at(2));
        assert.deepEqual(
          [changed?.name, changed?.place, changed?.lat, changed?.updatedAt],
          ["西門(仮)", null, null, at(2)],
        );
        assert.equal(await s.updatePosition({ ...p, no: 201 }, at(3)), null);

        const list = await s.listPositions();
        assert.equal(list.length, before + 1);
        assert.deepEqual(list.at(-1)?.no, 200);
        assert.equal(await s.deletePosition(200), true);
        assert.equal(await s.deletePosition(200), false);
      });

      it("記録に使われたポジションも消せる。過去の記録の番号は残る", async () => {
        const s = await make();
        await s.createPosition({ no: 210, name: "臨時", place: null, lat: null, lon: null }, at(0));
        await s.recordSignal(signal({ pos: 210 }), TEN_MIN);
        await s.createMessage(message({ kind: "order", icode: 1, pos: 210, body: "臨時へ移動してください" }), []);
        assert.equal(await s.deletePosition(210), true);
        assert.equal((await s.getLastSignal("dev-001"))?.pos, 210);
      });

      it("定型信号と指示コードの一覧は番号の順。SOS は 1 番", async () => {
        const s = await make();
        const codes = await s.listSignalCodes();
        assert.ok(codes.length > 0);
        assert.deepEqual(codes.map((c) => c.code), [...codes.map((c) => c.code)].sort((a, b) => a - b));
        assert.equal(codes.find((c) => c.isSos)?.code, 1);
        const ins = await s.listInstructionCodes();
        assert.ok(ins.length > 0);
        assert.equal(ins.find((c) => c.code === 1)?.usesPosition, true);
      });

      it("指示コードを足す・変える。同じ番号は足せない", async () => {
        const s = await make();
        const c = {
          code: 99,
          name: "点呼",
          usesPosition: false,
          textWithPos: null,
          textWithoutPos: "点呼をとってください",
          requiresResponse: false,
          strength: "request" as const,
        };
        assert.deepEqual(await s.createInstructionCode(c), c);
        assert.equal(await s.createInstructionCode(c), null);
        const changed = { ...c, name: "人数確認", requiresResponse: true };
        assert.deepEqual(await s.updateInstructionCode(changed), changed);
        assert.deepEqual((await s.listInstructionCodes()).find((x) => x.code === 99), changed);
        assert.equal(await s.updateInstructionCode({ ...c, code: 98 }), null);
      });
    });

    describe("本部から送ったものと、届いた確認", () => {
      it("id(= mid)が返り、宛先と送った時の経路が残る", async () => {
        const s = await make();
        const m = await s.createMessage(message(), [
          { deviceId: "dev-006", viaAtSend: "lora", skipped: true },
          { deviceId: "dev-001", viaAtSend: "wifi" },
          { deviceId: "dev-002", viaAtSend: "offline" },
        ]);
        assert.ok(m.id > 0);
        assert.equal(m.publishState, null);

        await s.setPublishState(m.id, "sent");
        assert.equal((await s.getMessage(m.id))?.publishState, "sent");

        const ds = await s.getDeliveries(m.id);
        assert.deepEqual(
          ds.map((d) => [d.deviceId, d.viaAtSend, d.skipped, d.ackedAt, d.response]),
          [
            ["dev-001", "wifi", false, null, null],
            ["dev-002", "offline", false, null, null],
            ["dev-006", "lora", true, null, null],
          ],
        );
        // 宛先の端末は、無ければ作られる
        assert.equal((await s.getDevice("dev-006"))?.registered, false);
      });

      it("指示コードの形と文字起こしは、そのまま読み戻せる", async () => {
        const s = await make();
        const order = await s.createMessage(
          message({ dst: "dev-001", kind: "order", icode: 1, pos: 3, body: "体育館前へ移動してください" }),
          [{ deviceId: "dev-001", viaAtSend: "wifi" }],
        );
        const tr = await s.createMessage(message({ seq: 8, source: "transcript", body: "各班、状況を確認" }), []);
        const o = await s.getMessage(order.id);
        assert.deepEqual(
          [o?.dst, o?.kind, o?.icode, o?.pos, o?.body, o?.source],
          ["dev-001", "order", 1, 3, "体育館前へ移動してください", "web"],
        );
        const t = await s.getMessage(tr.id);
        assert.deepEqual([t?.dst, t?.kind, t?.source, t?.icode, t?.pos], ["all", "free", "transcript", undefined, undefined]);
        assert.deepEqual(t?.sentAt, at(0));
        assert.equal(await s.getMessage(999999), null);
      });

      it("同じ 1 通・同じ端末の 2 回目の ack は保存しない(最初の時刻を残す)", async () => {
        const s = await make();
        const m = await s.createMessage(message({ dst: "dev-001" }), [{ deviceId: "dev-001", viaAtSend: "wifi" }]);
        assert.equal((await s.recordAck(m.id, "dev-001", at(1))).kind, "saved");
        assert.equal((await s.recordAck(m.id, "dev-001", at(2))).kind, "duplicate");
        assert.deepEqual((await s.getDeliveries(m.id))[0]?.ackedAt, at(1));
      });

      it("了解・できない は最初の返事だけ残す。返事が先に来ても届いたことにする", async () => {
        const s = await make();
        const m = await s.createMessage(message({ kind: "order", icode: 3, body: "その場で待機してください" }), [
          { deviceId: "dev-001", viaAtSend: "wifi" },
          { deviceId: "dev-002", viaAtSend: "wifi" },
        ]);
        await s.recordAck(m.id, "dev-001", at(1));
        assert.equal((await s.recordAck(m.id, "dev-001", at(4), "accepted")).kind, "saved");
        assert.equal((await s.recordAck(m.id, "dev-001", at(5), "declined")).kind, "duplicate");
        assert.equal((await s.recordAck(m.id, "dev-002", at(3), "declined")).kind, "saved");

        const [d1, d2] = await s.getDeliveries(m.id);
        assert.deepEqual([d1?.ackedAt, d1?.response, d1?.respondedAt], [at(1), "accepted", at(4)]);
        assert.deepEqual([d2?.ackedAt, d2?.response, d2?.respondedAt], [at(3), "declined", at(3)]);
      });

      it("宛先でない端末の ack は記録しない", async () => {
        const s = await make();
        const m = await s.createMessage(message({ dst: "dev-001" }), [{ deviceId: "dev-001", viaAtSend: "wifi" }]);
        assert.equal((await s.recordAck(m.id, "dev-002", at(1))).kind, "not_target");
        assert.equal((await s.recordAck(999999, "dev-001", at(1))).kind, "not_target");
      });

      it("一覧は新しい順。宛先の端末・期間・件数でしぼれる。届き具合はまとめて引ける", async () => {
        const s = await make();
        const a = await s.createMessage(message({ seq: 1, sentAt: at(0) }), [
          { deviceId: "dev-001", viaAtSend: "wifi" },
          { deviceId: "dev-002", viaAtSend: "wifi" },
        ]);
        const b = await s.createMessage(message({ seq: 2, dst: "dev-002", sentAt: at(60) }), [
          { deviceId: "dev-002", viaAtSend: "wifi" },
        ]);
        const c = await s.createMessage(message({ seq: 3, sentAt: at(120) }), []);
        const ids = async (f: Parameters<Storage["listMessages"]>[0]) => (await s.listMessages(f)).map((m) => m.id);
        assert.deepEqual(await ids({ limit: 10 }), [c.id, b.id, a.id]);
        assert.deepEqual(await ids({ deviceId: "dev-001", limit: 10 }), [a.id]);
        assert.deepEqual(await ids({ from: at(60), to: at(120), limit: 10 }), [b.id]);
        assert.deepEqual(await ids({ limit: 1 }), [c.id]);

        await s.recordAck(a.id, "dev-002", at(1));
        const map = await s.listDeliveries([a.id, c.id]);
        assert.deepEqual(map.get(a.id)?.map((d) => d.ackedAt), [null, at(1)]);
        assert.deepEqual(map.get(c.id), []);
        assert.equal((await s.listDeliveries([])).size, 0);
      });

      it("seq で探すと、since より後のものが新しい順に返る", async () => {
        const s = await make();
        await s.createMessage(message({ seq: 7, sentAt: at(0) }), []);
        const b = await s.createMessage(message({ seq: 7, sentAt: at(700) }), []);
        await s.createMessage(message({ seq: 8, sentAt: at(710) }), []);

        const found = await s.findMessagesBySeq(7, at(100));
        assert.deepEqual(found.map((m) => m.id), [b.id]);
      });

      it("再起動したときの pc の連番は、最後に送った 1 通の seq の次から", async () => {
        const s = await make();
        assert.equal(await s.getLastMessageSeq(), null);
        await s.createMessage(message({ seq: 65535, sentAt: at(0) }), []);
        await s.createMessage(message({ seq: 0, sentAt: at(1) }), []);
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
        // 原本を読む窓口はまだ無い(CSV 出力を作るときに足す)。ここでは落ちないことだけ確かめる
        assert.ok(id > 0);
      });
    });
  });
}
