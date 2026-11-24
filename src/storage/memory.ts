// 保存の窓口の、メモリ版(MySQL 版を使わないとき・テスト用)
//
// 再起動すると中身は消える。重複の判定と保存のあいだに await を挟まないので、
// 同時に届いても 1 件になる(MySQL 版ではトランザクションと行の鍵で同じことをする)。
// 2026-11-06: 一覧表・SOS の対応済み・了解/できない・記録の検索を足した(types.ts の変更に合わせた)

import { compareDeviceId } from "../protocol/topics.js";
import { type DedupRule, isSameSignal } from "./dedup.js";
import { SEED_INSTRUCTION_CODES, SEED_POSITIONS, SEED_SIGNAL_CODES } from "./seed.js";
import type {
  AckResponse,
  Channel,
  Delivery,
  Device,
  DeviceId,
  EventFilter,
  EventId,
  EventRecord,
  EventResult,
  InstructionCode,
  Message,
  MessageFilter,
  MessageTarget,
  NewEvent,
  NewMessage,
  NewSignal,
  OfflineCause,
  Position,
  PositionInput,
  PublishState,
  RecordAckResult,
  RecordSignalResult,
  Signal,
  SignalCode,
  SignalFilter,
  StatusUpdate,
  Storage,
  NewVoiceClip,
  VoiceClip,
  VoiceFilter,
  VoiceUpdate,
} from "./types.js";

interface StoredEvent extends NewEvent {
  id: EventId;
}

interface StoredOffline {
  deviceId: DeviceId;
  cause: OfflineCause;
  at: Date;
}

export interface MemoryStorageOptions {
  /** 一覧表を仮の中身(seed.ts)で始めるか。既定は true */
  seed?: boolean;
}

export class MemoryStorage implements Storage {
  // テストで中身を見られるように、読み取りだけ公開する
  readonly events: StoredEvent[] = [];
  readonly signals: Signal[] = [];
  readonly offlines: StoredOffline[] = [];
  private readonly devices = new Map<DeviceId, Device>();
  private readonly messages: Message[] = [];
  private readonly deliveries = new Map<number, Delivery[]>();
  private readonly positions = new Map<number, Position>();
  private readonly signalCodes = new Map<number, SignalCode>();
  private readonly instructionCodes = new Map<number, InstructionCode>();
  private readonly channels = new Map<number, Channel>();
  private nextCh = 1;
  private configRev = 0;
  private readonly voices: VoiceClip[] = [];

  constructor(options: MemoryStorageOptions = {}) {
    if (options.seed ?? true) {
      const at = new Date();
      for (const p of SEED_POSITIONS) this.positions.set(p.no, { ...p, updatedAt: at });
      for (const c of SEED_SIGNAL_CODES) this.signalCodes.set(c.code, { ...c });
      for (const c of SEED_INSTRUCTION_CODES) this.instructionCodes.set(c.code, { ...c });
    }
  }

  // ---- 原本 ----

  async saveEvent(event: NewEvent): Promise<EventId> {
    const id = this.events.length + 1;
    this.events.push({ ...event, id });
    return id;
  }

  async setEventResult(id: EventId, result: EventResult, note?: string): Promise<void> {
    const event = this.events[id - 1];
    if (!event) return;
    event.result = result;
    if (note !== undefined) event.note = note;
  }

  async listEvents(f: EventFilter): Promise<EventRecord[]> {
    return this.events
      .filter(
        (e) =>
          (!f.results || f.results.includes(e.result)) &&
          (f.deviceId === undefined || e.topic.includes(`/${f.deviceId}/`)) &&
          (f.direction === undefined || e.direction === f.direction),
      )
      .sort((a, b) => b.at.getTime() - a.at.getTime() || b.id - a.id)
      .slice(0, f.limit)
      .map((e) => ({ ...e }));
  }

  // ---- 定型信号 ----

  async recordSignal(signal: NewSignal, rule: DedupRule): Promise<RecordSignalResult> {
    const t = signal.receivedAt.getTime();
    if (this.signals.some((s) => isSameSignal(s, signal, rule))) return { kind: "duplicate" };

    // 端末の「今の値」は、受信時刻がいちばん新しい signal で決める。
    // 出口に溜まっていた古い signal が後から届いても、今の値を巻き戻さない
    const last = latest(this.signals.filter((s) => s.deviceId === signal.deviceId));
    const saved: Signal = {
      ...signal,
      id: this.signals.length + 1,
      outOfRange: signal.outOfRange ?? false,
      handledAt: null,
    };
    this.signals.push(saved);

    const device = this.ensureDevice(signal.deviceId, signal.receivedAt);
    if (!last || t >= last.receivedAt.getTime()) {
      device.pos = signal.pos === 0 ? null : signal.pos;
      if (signal.via) device.via = signal.via;
    }
    this.markSeen(device, signal.receivedAt);
    return { kind: "saved", signal: { ...saved } };
  }

  async getLastSignal(deviceId: DeviceId): Promise<Signal | null> {
    const s = latest(this.signals.filter((x) => x.deviceId === deviceId));
    return s ? { ...s } : null;
  }

  async getLastSignals(deviceIds: DeviceId[]): Promise<Map<DeviceId, Signal>> {
    const out = new Map<DeviceId, Signal>();
    for (const id of deviceIds) {
      const s = await this.getLastSignal(id);
      if (s) out.set(id, s);
    }
    return out;
  }

  async getSignal(id: number): Promise<Signal | null> {
    const s = this.signals[id - 1];
    return s ? { ...s } : null;
  }

  async listSignals(f: SignalFilter): Promise<Signal[]> {
    return this.signals
      .filter(
        (s) =>
          (f.deviceId === undefined || s.deviceId === f.deviceId) &&
          (f.codes === undefined || f.codes.includes(s.code)) &&
          (!f.unhandledOnly || s.handledAt === null) &&
          inRange(s.receivedAt, f.from, f.to),
      )
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime() || b.id - a.id)
      .slice(0, f.limit)
      .map((s) => ({ ...s }));
  }

  async handleSignal(id: number, at: Date): Promise<Signal | null> {
    const s = this.signals[id - 1];
    if (!s) return null;
    s.handledAt ??= at;
    return { ...s };
  }

  // ---- 端末 ----

  async recordStatus(update: StatusUpdate): Promise<void> {
    const device = this.ensureDevice(update.deviceId, update.receivedAt);
    if (update.battery !== undefined) device.battery = update.battery;
    if (update.glass !== undefined) device.glass = update.glass;
    if (update.via !== undefined) device.via = update.via;
    if (update.lat !== undefined) device.lat = update.lat;
    if (update.lon !== undefined) device.lon = update.lon;
    if (update.mode !== undefined) device.mode = update.mode;
    this.markSeen(device, update.receivedAt);
  }

  async touchDevice(deviceId: DeviceId, at: Date): Promise<void> {
    this.markSeen(this.ensureDevice(deviceId, at), at);
  }

  async markOffline(deviceId: DeviceId, cause: OfflineCause, at: Date, seenBefore?: Date): Promise<boolean> {
    const device = this.devices.get(deviceId);
    if (!device || !device.online) return false;
    if (seenBefore && device.lastSeenAt && device.lastSeenAt.getTime() >= seenBefore.getTime()) return false;
    device.online = false;
    this.offlines.push({ deviceId, cause, at });
    return true;
  }

  async registerDevice(deviceId: DeviceId, owner: string | null, at: Date): Promise<Device> {
    const device = this.devices.get(deviceId) ?? this.newDevice(deviceId, at);
    device.owner = owner;
    device.registered = true;
    this.devices.set(deviceId, device);
    return { ...device };
  }

  async updateOwner(deviceId: DeviceId, owner: string | null): Promise<Device | null> {
    const device = this.devices.get(deviceId);
    if (!device) return null;
    device.owner = owner;
    return { ...device };
  }

  async getDevice(deviceId: DeviceId): Promise<Device | null> {
    const device = this.devices.get(deviceId);
    return device ? { ...device } : null;
  }

  async listDevices(): Promise<Device[]> {
    return [...this.devices.values()].map((d) => ({ ...d })).sort((a, b) => compareDeviceId(a.id, b.id));
  }

  // ---- 一覧表 ----

  async listPositions(): Promise<Position[]> {
    return [...this.positions.values()].sort((a, b) => a.no - b.no).map((p) => ({ ...p }));
  }

  async createPosition(p: PositionInput, at: Date): Promise<Position | null> {
    if (this.positions.has(p.no)) return null;
    const saved = { ...p, updatedAt: at };
    this.positions.set(p.no, saved);
    return { ...saved };
  }

  async updatePosition(p: PositionInput, at: Date): Promise<Position | null> {
    if (!this.positions.has(p.no)) return null;
    const saved = { ...p, updatedAt: at };
    this.positions.set(p.no, saved);
    return { ...saved };
  }

  async deletePosition(no: number): Promise<boolean> {
    return this.positions.delete(no);
  }

  async listSignalCodes(): Promise<SignalCode[]> {
    return [...this.signalCodes.values()].sort((a, b) => a.code - b.code).map((c) => ({ ...c }));
  }

  async listInstructionCodes(): Promise<InstructionCode[]> {
    return [...this.instructionCodes.values()].sort((a, b) => a.code - b.code).map((c) => ({ ...c }));
  }

  async createInstructionCode(code: InstructionCode): Promise<InstructionCode | null> {
    if (this.instructionCodes.has(code.code)) return null;
    this.instructionCodes.set(code.code, { ...code });
    return { ...code };
  }

  async updateInstructionCode(code: InstructionCode): Promise<InstructionCode | null> {
    if (!this.instructionCodes.has(code.code)) return null;
    this.instructionCodes.set(code.code, { ...code });
    return { ...code };
  }

  // ---- チャンネル ----

  async listChannels(): Promise<Channel[]> {
    return [...this.channels.values()].sort((a, b) => a.ch - b.ch).map(copyChannel);
  }

  async getChannel(ch: number): Promise<Channel | null> {
    const c = this.channels.get(ch);
    return c ? copyChannel(c) : null;
  }

  async ensureDirectChannel(deviceId: DeviceId, name: string, at: Date): Promise<Channel> {
    this.ensureDevice(deviceId, at);
    const found = [...this.channels.values()].find((c) => c.kind === "direct" && c.members[0] === deviceId);
    if (found) return copyChannel(found);
    const c: Channel = { ch: this.nextCh++, kind: "direct", name, members: [deviceId], createdAt: at };
    this.channels.set(c.ch, c);
    return copyChannel(c);
  }

  async createGroupChannel(name: string, members: DeviceId[], at: Date): Promise<Channel> {
    for (const id of members) this.ensureDevice(id, at);
    const c: Channel = { ch: this.nextCh++, kind: "group", name, members: sortedIds(members), createdAt: at };
    this.channels.set(c.ch, c);
    return copyChannel(c);
  }

  async updateGroupChannel(ch: number, name: string, members: DeviceId[]): Promise<Channel | null> {
    const c = this.channels.get(ch);
    if (!c || c.kind !== "group") return null;
    for (const id of members) this.ensureDevice(id, c.createdAt);
    c.name = name;
    c.members = sortedIds(members);
    return copyChannel(c);
  }

  async deleteGroupChannel(ch: number): Promise<boolean> {
    const c = this.channels.get(ch);
    if (!c || c.kind !== "group") return false;
    return this.channels.delete(ch);
  }

  async getConfigRev(): Promise<number> {
    return this.configRev;
  }

  async bumpConfigRev(atLeast: number): Promise<number> {
    this.configRev = Math.max(this.configRev + 1, atLeast);
    return this.configRev;
  }

  // ---- 音声 ----

  async recordVoice(clip: NewVoiceClip, windowMs: number): Promise<{ kind: "saved" | "duplicate"; clip: VoiceClip }> {
    const t = clip.receivedAt.getTime();
    const dup = this.voices.find(
      (v) => v.deviceId === clip.deviceId && v.seq === clip.seq && Math.abs(v.receivedAt.getTime() - t) <= windowMs,
    );
    if (dup) return { kind: "duplicate", clip: { ...dup } };
    this.ensureDevice(clip.deviceId, clip.receivedAt);
    const saved: VoiceClip = {
      ...clip,
      id: this.voices.length + 1,
      status: "queued",
      text: null,
      error: null,
      messageId: null,
      attempts: 0,
      doneAt: null,
    };
    this.voices.push(saved);
    return { kind: "saved", clip: { ...saved } };
  }

  async updateVoice(id: number, update: VoiceUpdate): Promise<void> {
    const v = this.voices[id - 1];
    if (v) Object.assign(v, update);
  }

  async getVoice(id: number): Promise<VoiceClip | null> {
    const v = this.voices[id - 1];
    return v ? { ...v } : null;
  }

  async listVoices(f: VoiceFilter): Promise<VoiceClip[]> {
    return this.voices
      .filter((v) => (f.deviceId === undefined || v.deviceId === f.deviceId) && (!f.statuses || f.statuses.includes(v.status)))
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime() || b.id - a.id)
      .slice(0, f.limit)
      .map((v) => ({ ...v }));
  }

  // ---- 本部から送ったもの ----

  async createMessage(message: NewMessage, targets: MessageTarget[]): Promise<Message> {
    const saved: Message = { ...message, id: this.messages.length + 1, publishState: null };
    this.messages.push(saved);
    for (const t of targets) this.ensureDevice(t.deviceId, message.sentAt);
    this.deliveries.set(
      saved.id,
      targets
        .map((t) => ({
          deviceId: t.deviceId,
          viaAtSend: t.viaAtSend,
          skipped: t.skipped ?? false,
          ackedAt: null,
          response: null,
          respondedAt: null,
        }))
        .sort((a, b) => compareDeviceId(a.deviceId, b.deviceId)),
    );
    return { ...saved };
  }

  async setPublishState(messageId: number, state: PublishState): Promise<void> {
    const message = this.messages[messageId - 1];
    if (message) message.publishState = state;
  }

  async getMessage(messageId: number): Promise<Message | null> {
    const message = this.messages[messageId - 1];
    return message ? { ...message } : null;
  }

  async listMessages(f: MessageFilter): Promise<Message[]> {
    return this.messages
      .filter(
        (m) =>
          (f.deviceId === undefined ||
            (this.deliveries.get(m.id) ?? []).some((d) => d.deviceId === f.deviceId)) &&
          inRange(m.sentAt, f.from, f.to),
      )
      .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime() || b.id - a.id)
      .slice(0, f.limit)
      .map((m) => ({ ...m }));
  }

  async getLastMessageSeq(): Promise<number | null> {
    return this.messages.at(-1)?.seq ?? null;
  }

  async findMessagesBySeq(seq: number, since: Date): Promise<Message[]> {
    return this.messages
      .filter((m) => m.seq === seq && m.sentAt.getTime() > since.getTime())
      .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime() || b.id - a.id)
      .map((m) => ({ ...m }));
  }

  // ---- 届いた確認 ----

  async recordAck(
    messageId: number,
    deviceId: DeviceId,
    ackedAt: Date,
    response?: AckResponse,
  ): Promise<RecordAckResult> {
    const d = this.deliveries.get(messageId)?.find((x) => x.deviceId === deviceId);
    if (!d) return { kind: "not_target" };
    let changed = false;
    if (d.ackedAt === null) {
      d.ackedAt = ackedAt;
      changed = true;
    }
    if (response && d.response === null) {
      d.response = response;
      d.respondedAt = ackedAt;
      changed = true;
    }
    return { kind: changed ? "saved" : "duplicate" };
  }

  async getDeliveries(messageId: number): Promise<Delivery[]> {
    return (this.deliveries.get(messageId) ?? []).map((d) => ({ ...d }));
  }

  async listDeliveries(messageIds: number[]): Promise<Map<number, Delivery[]>> {
    const out = new Map<number, Delivery[]>();
    for (const id of messageIds) out.set(id, await this.getDeliveries(id));
    return out;
  }

  async close(): Promise<void> {
    // 閉じるものは無い
  }

  // ---- 内部 ----

  private newDevice(deviceId: DeviceId, at: Date): Device {
    return {
      id: deviceId,
      owner: null,
      online: false,
      via: null,
      battery: null,
      glass: null,
      pos: null,
      lat: null,
      lon: null,
      lastSeenAt: null,
      createdAt: at,
      registered: false,
      mode: null,
    };
  }

  /** 無ければ registered = false で作る(登録前の端末からも受け付ける。INTERFACES §3) */
  private ensureDevice(deviceId: DeviceId, at: Date): Device {
    let device = this.devices.get(deviceId);
    if (!device) {
      device = this.newDevice(deviceId, at);
      this.devices.set(deviceId, device);
    }
    return device;
  }

  /**
   * 届いた時刻が今の last_seen_at より新しいときだけ、last_seen_at と online を進める。
   * 出口に溜まっていた古いものが後から届いても、「つながった」にはしない
   */
  private markSeen(device: Device, at: Date): void {
    if (!device.lastSeenAt || at.getTime() > device.lastSeenAt.getTime()) {
      device.lastSeenAt = at;
      device.online = true;
    }
  }
}

function latest(signals: Signal[]): Signal | undefined {
  return signals.reduce<Signal | undefined>(
    (best, s) => (!best || s.receivedAt.getTime() >= best.receivedAt.getTime() ? s : best),
    undefined,
  );
}

function copyChannel(c: Channel): Channel {
  return { ...c, members: [...c.members] };
}

/** 重なりを除いて、端末ID の番号の順に並べる */
function sortedIds(ids: DeviceId[]): DeviceId[] {
  return [...new Set(ids)].sort(compareDeviceId);
}

function inRange(t: Date, from?: Date, to?: Date): boolean {
  return (!from || t.getTime() >= from.getTime()) && (!to || t.getTime() < to.getTime());
}
