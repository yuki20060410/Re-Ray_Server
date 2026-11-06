// 保存の窓口の、メモリ版(MySQL 版ができるまでの仮。テストでも使う)
//
// 再起動すると中身は消える。重複の判定と保存のあいだに await を挟まないので、
// 同時に届いても 1 件になる(MySQL 版ではトランザクションと行の鍵で同じことをする)。

import type {
  Delivery,
  Device,
  DeviceId,
  EventId,
  EventResult,
  Message,
  MessageTarget,
  NewEvent,
  NewMessage,
  NewSignal,
  PublishState,
  RecordAckResult,
  RecordSignalResult,
  Signal,
  StatusUpdate,
  Storage,
} from "./types.js";

interface StoredEvent extends NewEvent {
  id: EventId;
}

interface StoredAck {
  messageId: number;
  deviceId: DeviceId;
  ackedAt: Date;
}

export class MemoryStorage implements Storage {
  // テストで中身を見られるように、読み取りだけ公開する
  readonly events: StoredEvent[] = [];
  readonly signals: Signal[] = [];
  private readonly devices = new Map<DeviceId, Device>();
  private readonly messages: Message[] = [];
  private readonly targets = new Map<number, MessageTarget[]>();
  private readonly acks: StoredAck[] = [];

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

  // ---- 定型信号 ----

  async recordSignal(signal: NewSignal, windowMs: number): Promise<RecordSignalResult> {
    const t = signal.receivedAt.getTime();
    const duplicate = this.signals.some(
      (s) =>
        s.deviceId === signal.deviceId &&
        s.seq === signal.seq &&
        Math.abs(s.receivedAt.getTime() - t) <= windowMs,
    );
    if (duplicate) return { kind: "duplicate" };

    // 端末の「今の値」は、受信時刻がいちばん新しい signal で決める。
    // 出口に溜まっていた古い signal が後から届いても、今の値を巻き戻さない
    const last = latest(this.signals.filter((s) => s.deviceId === signal.deviceId));
    const saved: Signal = { ...signal, id: this.signals.length + 1 };
    this.signals.push(saved);

    const device = this.ensureDevice(signal.deviceId, signal.receivedAt);
    if (!last || t >= last.receivedAt.getTime()) {
      device.pos = signal.pos;
      if (signal.via) device.via = signal.via;
    }
    this.markSeen(device, signal.receivedAt);
    return { kind: "saved", signal: saved };
  }

  async getLastSignal(deviceId: DeviceId): Promise<Signal | null> {
    return latest(this.signals.filter((s) => s.deviceId === deviceId)) ?? null;
  }

  // ---- 端末 ----

  async recordStatus(update: StatusUpdate): Promise<void> {
    const device = this.ensureDevice(update.deviceId, update.receivedAt);
    if (update.battery !== undefined) device.battery = update.battery;
    if (update.glass !== undefined) device.glass = update.glass;
    if (update.via !== undefined) device.via = update.via;
    if (update.lat !== undefined) device.lat = update.lat;
    if (update.lon !== undefined) device.lon = update.lon;
    this.markSeen(device, update.receivedAt);
  }

  async touchDevice(deviceId: DeviceId, at: Date): Promise<void> {
    this.markSeen(this.ensureDevice(deviceId, at), at);
  }

  async setOnline(deviceId: DeviceId, online: boolean): Promise<void> {
    const device = this.devices.get(deviceId);
    if (device) device.online = online;
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
    return [...this.devices.values()]
      .map((d) => ({ ...d }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  // ---- 本部から送ったもの ----

  async createMessage(message: NewMessage, targets: MessageTarget[]): Promise<Message> {
    const saved: Message = { ...message, id: this.messages.length + 1, publishState: null };
    this.messages.push(saved);
    this.targets.set(saved.id, targets.map((t) => ({ ...t })));
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

  async recordAck(messageId: number, deviceId: DeviceId, ackedAt: Date): Promise<RecordAckResult> {
    if (this.acks.some((a) => a.messageId === messageId && a.deviceId === deviceId)) {
      return { kind: "duplicate" };
    }
    this.acks.push({ messageId, deviceId, ackedAt });
    return { kind: "saved" };
  }

  async getDeliveries(messageId: number): Promise<Delivery[]> {
    return (this.targets.get(messageId) ?? []).map((t) => ({
      ...t,
      ackedAt:
        this.acks.find((a) => a.messageId === messageId && a.deviceId === t.deviceId)?.ackedAt ??
        null,
    }));
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
