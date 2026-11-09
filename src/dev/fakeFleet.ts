// 偽の端末(実機ができるまでの試験用。DEV_TOOLS=1 のときだけサーバーの中で動かす)
//
// 本物と同じ決まり(INTERFACES §1・§2)で MQTT につなぎ、30 秒ごとに status を送り、遺言を登録し、
// 届いた文字・指示に返事をする:
// - Wi-Fi は約 1 秒、LoRa は約 5 秒で「受け取った」(ack_kind 3)。LoRa 中は自由な文を受け取らない(指示だけ)
// - グラスのある端末は、指示に数秒後「了解」(4)。番号が 5 の倍数の端末は「できない」(5)
// 2026-11-06 作成(reray-app の server/fake-devices.js を TypeScript に直して取り込んだ)
// 1 台だけを手で動かすなら tools/fake-device.ts(npm run fake)

import mqtt, { type MqttClient } from "mqtt";
import { ApiError, type DevTools } from "../http/app.js";
import { deviceNumber } from "../protocol/topics.js";
import type { Receiver } from "../server/receiver.js";
import type { Storage, Via } from "../storage/types.js";

const PREFIX = "reray/v1";
const STATUS_INTERVAL_MS = 30 * 1000;
const unixNow = () => Math.floor(Date.now() / 1000);

export interface FakeDeviceOptions {
  url: string;
  id: string;
  via?: Via;
  glass?: boolean;
  battery?: number;
  pos?: number;
}

export class FakeDevice {
  readonly id: string;
  via: Via;
  glass: boolean;
  battery: number;
  pos: number;
  /** 送った seq → 「本部に届いた」が来たか */
  readonly hqAcked = new Map<number, boolean>();
  private readonly url: string;
  private readonly no: number;
  private seq = Math.floor(Math.random() * 65536); // 端末と同じく、起動時の乱数から(修正案 #3)
  private client: MqttClient | null = null;
  private statusTimer: NodeJS.Timeout | undefined;
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(o: FakeDeviceOptions) {
    this.url = o.url;
    this.id = o.id;
    this.no = deviceNumber(o.id) ?? 0;
    this.via = o.via ?? "wifi";
    this.glass = o.glass ?? true;
    this.battery = o.battery ?? 90;
    this.pos = o.pos ?? 0;
  }

  get connected(): boolean {
    return Boolean(this.client?.connected);
  }

  /** つなぐ。遺言を登録し、下りを購読し、status を送り始める */
  async connect(): Promise<this> {
    const client = mqtt.connect(this.url, {
      clientId: this.id,
      protocolVersion: 4,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 0,
      will: {
        topic: `${PREFIX}/up/${this.id}/status`,
        payload: Buffer.from(JSON.stringify({ v: 1, type: "status", src: this.id, online: false })),
        qos: 1,
        retain: false,
      },
    });
    this.client = client;
    client.on("message", (topic, payload) => this.onMessage(payload));
    client.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      client.once("connect", () => resolve());
      client.once("error", reject);
    });
    await client.subscribeAsync([`${PREFIX}/down/${this.id}/#`, `${PREFIX}/down/all/#`], { qos: 1 });
    this.sendStatus();
    this.statusTimer = setInterval(() => this.sendStatus(), STATUS_INTERVAL_MS);
    return this;
  }

  /** 黙って切れる(DISCONNECT を送らないので、ブローカーが遺言を流す) */
  dropSilently(): void {
    this.stopTimers();
    this.client?.stream.destroy();
    this.client?.end(true);
    this.client = null;
  }

  /** 行儀よく切る(遺言は流れない) */
  async close(): Promise<void> {
    this.stopTimers();
    await this.client?.endAsync().catch(() => undefined);
    this.client = null;
  }

  sendStatus(): void {
    this.publish("status", {
      v: 1, type: "status", src: this.id, seq: this.nextSeq(), ts: unixNow(),
      battery: this.battery, glass: this.glass, ...(this.via === "lora" && { via: "lora" }),
    }, 0);
  }

  /** 定型信号を送る。戻り値は seq */
  sendSignal(code: number, o: { n?: number; dir?: number; pos?: number } = {}): number {
    const seq = this.nextSeq();
    this.hqAcked.set(seq, false);
    this.publishSignal(seq, code, o);
    return seq;
  }

  /** 同じ seq でもう一度送る(送り直し・重複の試験用) */
  resendSignal(seq: number, code: number): void {
    this.publishSignal(seq, code, {});
  }

  setVia(via: Via): void {
    this.via = via;
    this.sendStatus();
  }

  private publishSignal(seq: number, code: number, o: { n?: number; dir?: number; pos?: number }): void {
    this.publish("signal", {
      v: 1, type: "signal", src: this.id, seq, ts: unixNow(), code, pos: o.pos ?? this.pos, via: this.via,
      ...(o.n !== undefined && { n: o.n }), ...(o.dir !== undefined && { dir: o.dir }),
    }, 1);
  }

  private onMessage(payload: Buffer): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
    } catch {
      return;
    }
    // 本部に届いた
    if (msg.type === "ack" && msg.ack_src === this.id && typeof msg.ack_seq === "number") {
      this.hqAcked.set(msg.ack_seq, true);
      return;
    }
    if (msg.type !== "text" || (msg.dst !== "all" && msg.dst !== this.id) || typeof msg.mid !== "number") return;
    const order = msg.icode !== undefined;
    if (this.via === "lora" && !order) return; // LoRa では自由な文は届かない

    const mid = msg.mid;
    const lag = (this.via === "lora" ? 5000 : 1000) + (this.no % 20) * 150;
    this.later(lag, () => this.ack(mid, 3));
    if (order && this.glass) {
      this.later(lag + 3000 + (this.no % 10) * 700, () => this.ack(mid, this.no % 5 === 0 ? 5 : 4));
    }
  }

  private ack(mid: number, kind: 3 | 4 | 5): void {
    this.publish("ack", { v: 1, type: "ack", src: this.id, seq: this.nextSeq(), ts: unixNow(), ack_mid: mid, ack_kind: kind }, 1);
  }

  private publish(kind: string, body: unknown, qos: 0 | 1): void {
    if (this.connected) this.client?.publish(`${PREFIX}/up/${this.id}/${kind}`, JSON.stringify(body), { qos });
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private stopTimers(): void {
    clearInterval(this.statusTimer);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private nextSeq(): number {
    this.seq = (this.seq + 1) & 0xffff;
    return this.seq;
  }
}

/** サーバーの中で偽の端末をまとめて動かし、管理画面の「テスト用」の操作(DevTools)を受ける */
export class FakeFleet implements DevTools {
  private readonly devices = new Map<string, FakeDevice>();

  constructor(
    private readonly url: string,
    private readonly storage: Storage,
    private readonly receiver: Receiver,
  ) {}

  /** 端末の今の状態(経路・グラス・電池・ポジション)を引き継いで、偽の端末をつなぐ */
  async start(ids: string[]): Promise<string[]> {
    for (const id of ids) await this.startOne(id);
    return [...this.devices.keys()];
  }

  async stopAll(): Promise<void> {
    for (const d of this.devices.values()) await d.close();
    this.devices.clear();
  }

  async signal(deviceId: string, code: number, n?: number): Promise<{ sent: "mqtt" | "direct"; seq: number }> {
    const fake = this.connected(deviceId);
    if (fake) {
      const seq = fake.sendSignal(code, n === undefined ? {} : { n });
      await sleep(300); // 記録されるのを少し待つ(画面がすぐ読み直すので)
      return { sent: "mqtt", seq };
    }
    // 偽の端末がつながっていない: MQTT を通さず、受信の処理に直接渡す(LoRa の出口から届いた想定など)
    const d = await this.storage.getDevice(deviceId);
    const seq = Math.floor(Math.random() * 65536);
    const body = {
      v: 1, type: "signal", src: deviceId, seq, ts: unixNow(), code, pos: d?.pos ?? 0, via: d?.via ?? "wifi",
      ...(n !== undefined && { n }),
    };
    await this.receiver.handle(`${PREFIX}/up/${deviceId}/signal`, Buffer.from(JSON.stringify(body)));
    return { sent: "direct", seq };
  }

  async toggleOnline(deviceId: string): Promise<"connected" | "dropped"> {
    const fake = this.connected(deviceId);
    if (fake) {
      fake.dropSilently();
      this.devices.delete(deviceId);
      await sleep(500); // 遺言が届くのを少し待つ
      return "dropped";
    }
    await this.startOne(deviceId);
    await sleep(300);
    return "connected";
  }

  async toggleVia(deviceId: string): Promise<Via> {
    const fake = this.connected(deviceId);
    if (!fake) throw new ApiError(422, "not_connected", "つながっていない端末です。先に「つながりを切り替える」でつないでください");
    fake.setVia(fake.via === "lora" ? "wifi" : "lora");
    await sleep(300);
    return fake.via;
  }

  /** 負荷試験などで外から使う */
  get(deviceId: string): FakeDevice | undefined {
    return this.devices.get(deviceId);
  }

  private connected(deviceId: string): FakeDevice | null {
    const d = this.devices.get(deviceId);
    return d?.connected ? d : null;
  }

  private async startOne(id: string): Promise<void> {
    await this.devices.get(id)?.close();
    const d = await this.storage.getDevice(id);
    const fake = new FakeDevice({
      url: this.url,
      id,
      via: d?.via ?? "wifi",
      glass: d?.glass ?? true,
      battery: d?.battery ?? 90,
      pos: d?.pos ?? 0,
    });
    await fake.connect();
    this.devices.set(id, fake);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
