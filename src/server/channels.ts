// チャンネル【案】(端末からの依頼 2026-11-17 の #1〜3。端末の設計 DESIGN.md §5)
//
// - 1 対 1(direct): 本部とその端末。登録した端末ごとに 1 つ、サーバーが作る(名前は「本部」)
// - グループ(group): 管理画面で作り、入る端末を選ぶ
// - 端末に配る設定(config): その端末が入っているチャンネルの一覧。`reray/v1/down/{id}/config` に
//   **保持つき(retain)**で流す(つないだ直後にも届くように。ほかのトピックは retain を使わない。例外)。
//   チャンネルを変えたら、関係する端末に流し直す。サーバーがブローカーにつながるたびに、全端末に流し直す
// HTTP にも MQTT にも依存しない(publish を受け取る)。2026-11-24 作成

import { deviceNumber } from "../protocol/topics.js";
import type { Channel, DeviceId, Storage } from "../storage/types.js";
import type { PcSeq } from "./pcSeq.js";

/** 1 対 1 のチャンネルの名前 */
export const DIRECT_NAME = "本部";
/** 名前の上限(端末の都合: 全角 8 文字。端末からの依頼 §4.1) */
export const CHANNEL_NAME_MAX = 8;
/** 1 台が入れるチャンネルの数(1 対 1 を含む。端末の都合) */
export const CHANNELS_PER_DEVICE_MAX = 8;
/** 設定 1 通の大きさの上限(端末の都合。バイト) */
export const CONFIG_BYTES_MAX = 1500;

export function configTopic(deviceId: DeviceId): string {
  return `reray/v1/down/${deviceId}/config`;
}

/** 管理画面からの変更が通らなかった理由。status は API がそのまま返す */
export class ChannelError extends Error {
  constructor(
    readonly status: 404 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ChannelServiceDeps {
  storage: Storage;
  pcSeq: PcSeq;
  /** QoS 1・**retain あり**で流す */
  publishRetained: (topic: string, payload: string) => Promise<void>;
  now?: () => Date;
  log?: Pick<Console, "info" | "warn" | "error">;
}

export class ChannelService {
  private readonly storage: Storage;
  private readonly pcSeq: PcSeq;
  private readonly publishRetained: ChannelServiceDeps["publishRetained"];
  private readonly now: () => Date;
  private readonly log: NonNullable<ChannelServiceDeps["log"]>;

  constructor(deps: ChannelServiceDeps) {
    this.storage = deps.storage;
    this.pcSeq = deps.pcSeq;
    this.publishRetained = deps.publishRetained;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? console;
  }

  // ---- 管理画面から ----

  async createGroup(name: unknown, members: unknown): Promise<Channel> {
    const n = checkName(name);
    const ids = await this.checkMembers(members, null);
    const c = await this.storage.createGroupChannel(n, ids, this.now());
    await this.changed(c.members);
    return c;
  }

  async updateGroup(ch: number, name: unknown, members: unknown): Promise<Channel> {
    const before = await this.storage.getChannel(ch);
    if (!before) throw new ChannelError(404, "not_found", `チャンネル ${ch} はありません`);
    if (before.kind !== "group") throw new ChannelError(422, "direct_channel", "本部との 1 対 1 のチャンネルは変えられません");
    const n = checkName(name);
    const ids = await this.checkMembers(members, ch);
    const c = await this.storage.updateGroupChannel(ch, n, ids);
    if (!c) throw new ChannelError(404, "not_found", `チャンネル ${ch} はありません`);
    // 抜けた端末にも、新しい一覧を配る
    await this.changed([...new Set([...before.members, ...c.members])]);
    return c;
  }

  async deleteGroup(ch: number): Promise<void> {
    const before = await this.storage.getChannel(ch);
    if (!before) throw new ChannelError(404, "not_found", `チャンネル ${ch} はありません`);
    if (before.kind !== "group") throw new ChannelError(422, "direct_channel", "本部との 1 対 1 のチャンネルは消せません");
    await this.storage.deleteGroupChannel(ch);
    await this.changed(before.members);
  }

  /** 端末を登録したとき: 1 対 1 のチャンネルを作り、設定を配る */
  async deviceRegistered(deviceId: DeviceId): Promise<void> {
    await this.publishTo([deviceId]);
  }

  // ---- 端末へ ----

  /** その端末に配る設定(1 対 1 を先頭に、あとは番号の順)。1 対 1 が無ければ作る */
  async configFor(deviceId: DeviceId): Promise<DeviceConfig> {
    await this.ensureDirect(deviceId);
    const [rev, all] = await Promise.all([this.storage.getConfigRev(), this.storage.listChannels()]);
    const mine = all
      .filter((c) => c.members.includes(deviceId))
      .sort((a, b) => (a.kind === b.kind ? a.ch - b.ch : a.kind === "direct" ? -1 : 1));
    return { rev, channels: mine.map((c) => ({ ch: c.ch, kind: c.kind, name: c.name })) };
  }

  /** 登録した全端末に配り直す(サーバーがブローカーにつながるたびに呼ぶ) */
  async publishAll(): Promise<void> {
    const ids = (await this.storage.listDevices()).filter((d) => d.registered).map((d) => d.id);
    await this.publishTo(ids);
  }

  /** 流せなくても止めない(つなぎ直したときの publishAll で配り直す) */
  async publishTo(deviceIds: DeviceId[]): Promise<void> {
    for (const id of deviceIds) {
      const device = await this.storage.getDevice(id);
      if (!device?.registered) continue; // 登録していない端末には配らない(送る先にもならないため)
      const config = await this.configFor(id);
      const at = this.now();
      const payload = JSON.stringify({
        v: 1,
        type: "config",
        src: "pc",
        dst: id,
        seq: this.pcSeq.next(),
        ts: Math.floor(at.getTime() / 1000),
        rev: config.rev,
        channels: config.channels,
      });
      if (Buffer.byteLength(payload) > CONFIG_BYTES_MAX) {
        this.log.error(`設定が大きすぎて配れない(${id}、${Buffer.byteLength(payload)} バイト)`);
        continue;
      }
      const topic = configTopic(id);
      try {
        await this.publishRetained(topic, payload);
        await this.storage.saveEvent({ at, direction: "down", topic, payload, result: "sent" });
      } catch (err) {
        this.log.warn(`設定を配れなかった(つないだときに配り直す): ${topic}`, err);
        await this.storage.saveEvent({ at, direction: "down", topic, payload, result: "failed", note: String(err).slice(0, 255) });
      }
    }
  }

  /**
   * その端末の 1 対 1 のチャンネル。無ければ作り、**設定の版も上げる**
   * (前の版を覚えている端末が、増えたチャンネルを見落とさないように)
   */
  async ensureDirect(deviceId: DeviceId): Promise<Channel> {
    const existing = (await this.storage.listChannels()).find((c) => c.kind === "direct" && c.members[0] === deviceId);
    if (existing) return existing;
    const c = await this.storage.ensureDirectChannel(deviceId, DIRECT_NAME, this.now());
    await this.storage.bumpConfigRev(this.revFloor());
    return c;
  }

  // ---- 内部 ----

  /** 版の下限 = 今の時刻(UNIX 秒)。DB を作り直しても、前に配った版より小さくならないように */
  private revFloor(): number {
    return Math.floor(this.now().getTime() / 1000);
  }

  /** 変わった: 版を上げて、関係する端末に配る */
  private async changed(deviceIds: DeviceId[]): Promise<void> {
    await this.storage.bumpConfigRev(this.revFloor());
    await this.publishTo(deviceIds);
  }

  /** 入れる端末: 登録した端末だけ。1 台が入れる数の上限を超えないこと */
  private async checkMembers(members: unknown, ch: number | null): Promise<DeviceId[]> {
    if (!Array.isArray(members)) throw new ChannelError(422, "bad_members", "入れる端末を選んでください");
    const ids = [...new Set(members)];
    for (const id of ids) {
      if (typeof id !== "string" || deviceNumber(id) === null) {
        throw new ChannelError(422, "bad_members", "端末ID は dev-001 の形で入れてください");
      }
      if (!(await this.storage.getDevice(id))?.registered) {
        throw new ChannelError(422, "unknown_device", `${id} は登録されていません`);
      }
    }
    const all = await this.storage.listChannels();
    for (const id of ids as DeviceId[]) {
      // 1 対 1 は、まだ無くても必ず 1 つ数える
      const groups = all.filter((c) => c.kind === "group" && c.ch !== ch && c.members.includes(id)).length;
      if (1 + groups + 1 > CHANNELS_PER_DEVICE_MAX) {
        throw new ChannelError(
          422,
          "too_many_channels",
          `${id} はもう ${CHANNELS_PER_DEVICE_MAX} 個のチャンネルに入っています(本部との 1 対 1 を含む)`,
        );
      }
    }
    return ids as DeviceId[];
  }
}

export interface DeviceConfig {
  rev: number;
  channels: { ch: number; kind: Channel["kind"]; name: string }[];
}

function checkName(name: unknown): string {
  const s = typeof name === "string" ? name.trim() : "";
  if (!s) throw new ChannelError(422, "missing_name", "チャンネルの名前を入れてください");
  if ([...s].length > CHANNEL_NAME_MAX) {
    throw new ChannelError(422, "name_too_long", `チャンネルの名前は${CHANNEL_NAME_MAX}文字までです(グラスの都合)`);
  }
  return s;
}
