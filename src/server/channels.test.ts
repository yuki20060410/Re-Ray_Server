// チャンネル【案】のテスト。ブローカーなしで、配った設定を記録して確かめる(2026-11-24 作成)

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStorage } from "../storage/memory.js";
import { CHANNEL_NAME_MAX, CHANNELS_PER_DEVICE_MAX, ChannelError, ChannelService } from "./channels.js";
import { PcSeq } from "./pcSeq.js";

const T0 = Date.parse("2026-11-24T00:00:00.000Z");
const quiet = { info() {}, warn() {}, error() {} };

async function setup(opts: { failPublish?: boolean } = {}) {
  const storage = new MemoryStorage();
  const config: { topic: string; body: Record<string, unknown> }[] = [];
  const channels = new ChannelService({
    storage,
    pcSeq: new PcSeq(0),
    now: () => new Date(T0),
    log: quiet,
    publishRetained: async (topic, payload) => {
      if (opts.failPublish) throw new Error("not connected");
      config.push({ topic, body: JSON.parse(payload) });
    },
  });
  for (const [id, owner] of [["dev-001", "山田"], ["dev-002", "佐藤"], ["dev-003", "鈴木"]] as const) {
    await storage.registerDevice(id, owner, new Date(T0));
  }
  await storage.touchDevice("dev-009", new Date(T0)); // 受信で見つけただけ(未登録)
  return { storage, channels, config };
}

async function rejects(p: Promise<unknown>, status: number, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof ChannelError && e.status === status && e.code === code);
}

/** その端末に最後に配った設定 */
function lastConfig(config: { topic: string; body: Record<string, unknown> }[], id: string) {
  return config.filter((c) => c.topic === `reray/v1/down/${id}/config`).at(-1)?.body;
}

describe("チャンネル【案】", () => {
  it("登録した端末に、1 対 1(本部)を先頭にした設定を配る", async () => {
    const { channels, config } = await setup();
    const g = await channels.createGroup("北班", ["dev-001", "dev-002"]);
    const c = lastConfig(config, "dev-001");
    const direct = await channels.ensureDirect("dev-001");

    assert.deepEqual(c?.channels, [
      { ch: direct.ch, kind: "direct", name: "本部" },
      { ch: g.ch, kind: "group", name: "北班" },
    ]);
    assert.deepEqual([c?.v, c?.type, c?.src, c?.dst], [1, "config", "pc", "dev-001"]);
    assert.equal(typeof c?.rev, "number");
    // 入っていない端末には配らない
    assert.equal(lastConfig(config, "dev-003"), undefined);
  });

  it("変えるたびに版が上がる。抜けた端末にも、新しい一覧を配る", async () => {
    const { channels, config } = await setup();
    const g = await channels.createGroup("北班", ["dev-001", "dev-002"]);
    const rev1 = lastConfig(config, "dev-002")?.rev as number;
    await channels.updateGroup(g.ch, "北班A", ["dev-001"]);

    const after = lastConfig(config, "dev-002");
    assert.ok((after?.rev as number) > rev1);
    assert.deepEqual(
      (after?.channels as { kind: string }[]).map((c) => c.kind),
      ["direct"],
    );
    assert.deepEqual(
      (lastConfig(config, "dev-001")?.channels as { name: string }[]).map((c) => c.name),
      ["本部", "北班A"],
    );
  });

  it("消すと、入っていた端末から一覧が消える", async () => {
    const { channels, config } = await setup();
    const g = await channels.createGroup("北班", ["dev-001"]);
    await channels.deleteGroup(g.ch);
    assert.deepEqual(
      (lastConfig(config, "dev-001")?.channels as { kind: string }[]).map((c) => c.kind),
      ["direct"],
    );
  });

  it("1 対 1 を後から作ったときも版が上がる(前の版を覚えている端末が見落とさないように)", async () => {
    const { storage, channels } = await setup();
    const rev0 = await storage.getConfigRev();
    await channels.ensureDirect("dev-003");
    const rev1 = await storage.getConfigRev();
    assert.ok(rev1 > rev0);
    await channels.ensureDirect("dev-003"); // 2 回目は作らないので上がらない
    assert.equal(await storage.getConfigRev(), rev1);
  });

  it("版は今の時刻(UNIX 秒)より小さくならない(DB を作り直しても、端末が覚えている前の版を超える)", async () => {
    const { storage, channels } = await setup();
    await channels.createGroup("北班", ["dev-001"]);
    assert.ok((await storage.getConfigRev()) >= Math.floor(T0 / 1000));
  });

  it("全端末への配り直しは、登録した端末だけ", async () => {
    const { channels, config } = await setup();
    await channels.publishAll();
    assert.deepEqual(
      config.map((c) => c.topic),
      ["reray/v1/down/dev-001/config", "reray/v1/down/dev-002/config", "reray/v1/down/dev-003/config"],
    );
  });

  it("確かめて断る: 名前、登録していない端末、形の違う端末ID、1 対 1 を変える・消す", async () => {
    const { channels } = await setup();
    await rejects(channels.createGroup("", ["dev-001"]), 422, "missing_name");
    await rejects(channels.createGroup("あ".repeat(CHANNEL_NAME_MAX + 1), []), 422, "name_too_long");
    await channels.createGroup("あ".repeat(CHANNEL_NAME_MAX), []); // ちょうどは作れる
    await rejects(channels.createGroup("北班", ["dev-009"]), 422, "unknown_device");
    await rejects(channels.createGroup("北班", ["dev-1"]), 422, "bad_members");
    await rejects(channels.createGroup("北班", "dev-001"), 422, "bad_members");

    const direct = await channels.ensureDirect("dev-001");
    await rejects(channels.updateGroup(direct.ch, "x", []), 422, "direct_channel");
    await rejects(channels.deleteGroup(direct.ch), 422, "direct_channel");
    await rejects(channels.updateGroup(999, "x", []), 404, "not_found");
    await rejects(channels.deleteGroup(999), 404, "not_found");
  });

  it(`1 台が入れるのは ${CHANNELS_PER_DEVICE_MAX} 個まで(1 対 1 を含む)`, async () => {
    const { channels } = await setup();
    const groups = [];
    for (let i = 1; i < CHANNELS_PER_DEVICE_MAX; i++) groups.push(await channels.createGroup(`班${i}`, ["dev-001"]));
    await rejects(channels.createGroup("多すぎ", ["dev-001"]), 422, "too_many_channels");
    // 今入っているグループの名前を変えるのは、数が増えないので通る
    await channels.updateGroup(groups[0]!.ch, "班1改", ["dev-001"]);
  });

  it("配れなくても止めない(原本に failed で残る)", async () => {
    const { storage, channels } = await setup({ failPublish: true });
    await channels.createGroup("北班", ["dev-001"]);
    assert.equal(storage.events.at(-1)?.result, "failed");
  });
});
