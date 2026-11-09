// 保存の窓口の、MySQL 版(B 案の表: db/init/01_schema.sql + サーバーの追加 03_server.sql)
//
// 窓口の外の決まり(端末ID は `dev-001`、ポジション 0 = 場所なし、種類は free / order)と、
// B 案の表の決まり(端末ID は数値、ポジションなしは NULL、kind は text / instruction / transcript)の
// 付け替えは、**このファイルの中だけ**で行う。DB の土台が変わったら(DB-012〜014)、ここだけ直す。
//
// - 時刻: B 案に合わせて日本時間(+09:00)で持つ(DB_TIME_ZONE)。どの接続も最初にこの時間帯にそろえる
//   (DB案の比較 §1 #1: つなぐ側ごとに時間帯がばらばらだと、同じ表に UTC と日本時間が混ざる)。
//   時刻はすべてサーバーが渡し、DB の既定値(CURRENT_TIMESTAMP)には頼らない(DB-018)。
// - 重複の判定: 端末の行を先に作ってから鍵(FOR UPDATE)をかけ、判定と保存を 1 つのトランザクションにする(DB-017)。
// - 了解・できない(response)、SOS の対応済み(handled_at)、送らなかった印(is_skipped)は B 案の列をそのまま使う。
// 2026-11-06 作成(reray-app の server.js・mqtt-bridge.js の SQL を、窓口の形に直して取り込んだ)

import mysql, { type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import { deviceNumber, formatDeviceId } from "../protocol/topics.js";
import type {
  AckResponse,
  Delivery,
  Device,
  DeviceId,
  EventId,
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
  Rule,
  Signal,
  SignalCode,
  SignalFilter,
  StatusUpdate,
  Storage,
  Via,
  ViaAtSend,
} from "./types.js";

/** DB の時刻の時間帯(B 案は日本時間。DB-012 で UTC に決まったら '+00:00' にする) */
export const DB_TIME_ZONE = "+09:00";

export interface MysqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

type Queryable = Pool | PoolConnection;

/** デッドロックで負けたトランザクションは、やり直せば通る(同じ端末に同時に届いたときなど) */
const RETRY_ERRORS = new Set(["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"]);

export class MysqlStorage implements Storage {
  private constructor(private readonly pool: Pool) {}

  static create(config: MysqlConfig): MysqlStorage {
    const pool = mysql.createPool({
      ...config,
      charset: "utf8mb4",
      timezone: DB_TIME_ZONE, // Date ⇔ DATETIME の付け替えに使う
      decimalNumbers: true, // DECIMAL(緯度経度)を数で受け取る
      supportBigNumbers: true,
      connectionLimit: 10,
    });
    // つないだら最初に、NOW() の時間帯と、トランザクションの分け方をそろえる
    pool.pool.on("connection", (conn) => {
      conn.query(`SET time_zone = '${DB_TIME_ZONE}'`);
      conn.query("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED");
    });
    return new MysqlStorage(pool);
  }

  /** つながるか確かめる(起動時に呼ぶ) */
  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ---- 原本 ----

  async saveEvent(e: NewEvent): Promise<EventId> {
    const r = await exec(
      this.pool,
      "INSERT INTO events (at, direction, topic, payload, result, note) VALUES (?, ?, ?, ?, ?, ?)",
      [e.at, e.direction, e.topic, e.payload, e.result, e.note ?? null],
    );
    return r.insertId;
  }

  async setEventResult(id: EventId, result: EventResult, note?: string): Promise<void> {
    await exec(this.pool, "UPDATE events SET result = ?, note = COALESCE(?, note) WHERE id = ?", [
      result,
      note ?? null,
      id,
    ]);
  }

  // ---- 定型信号 ----

  async recordSignal(signal: NewSignal, windowMs: number): Promise<RecordSignalResult> {
    const no = toNo(signal.deviceId);
    const t = signal.receivedAt.getTime();
    return this.tx(async (c) => {
      // 先に行を作ってから鍵をかける(行が無いと FOR UPDATE は何も鍵をかけない。DB-017)
      await ensureDevice(c, no, signal.receivedAt);
      const [dev] = await rows<{ last_at: Date | null; is_online: number }>(
        c,
        `SELECT s.received_at AS last_at, d.is_online FROM devices d
           LEFT JOIN signals s ON s.id = d.last_signal_id
          WHERE d.id = ? FOR UPDATE OF d`,
        [no],
      );
      const dup = await rows(
        c,
        "SELECT id FROM signals WHERE device_id = ? AND seq = ? AND received_at BETWEEN ? AND ? LIMIT 1",
        [no, signal.seq, new Date(t - windowMs), new Date(t + windowMs)],
      );
      if (dup.length) return { kind: "duplicate" } as const;

      const ins = await exec(
        c,
        `INSERT INTO signals (device_id, seq, code, position_id, quantity, direction, is_out_of_range, via, device_ts, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          no,
          signal.seq,
          signal.code,
          signal.pos || null,
          signal.n ?? null,
          signal.dir ?? null,
          signal.outOfRange ?? false,
          signal.via,
          signal.deviceTs,
          signal.receivedAt,
        ],
      );
      // 端末の「今の値」は、受信時刻がいちばん新しい signal で決める(古いものが後から届いても巻き戻さない)
      if (!dev?.last_at || t >= dev.last_at.getTime()) {
        await exec(c, "UPDATE devices SET last_signal_id = ?, position_id = ?, via = COALESCE(?, via) WHERE id = ?", [
          ins.insertId,
          signal.pos || null,
          signal.via,
          no,
        ]);
      }
      await markSeen(c, no, signal.receivedAt, Boolean(dev?.is_online));
      const saved = await this.signalById(c, ins.insertId);
      if (!saved) throw new Error("保存した signal が読めない");
      return { kind: "saved", signal: saved } as const;
    });
  }

  async getLastSignal(deviceId: DeviceId): Promise<Signal | null> {
    return (await this.getLastSignals([deviceId])).get(deviceId) ?? null;
  }

  async getLastSignals(deviceIds: DeviceId[]): Promise<Map<DeviceId, Signal>> {
    const out = new Map<DeviceId, Signal>();
    if (!deviceIds.length) return out;
    const list = await rows<SignalRow>(
      this.pool,
      "SELECT s.* FROM devices d JOIN signals s ON s.id = d.last_signal_id WHERE d.id IN (?)",
      [deviceIds.map(toNo)],
    );
    for (const r of list) out.set(formatDeviceId(r.device_id), toSignal(r));
    return out;
  }

  async getSignal(id: number): Promise<Signal | null> {
    return this.signalById(this.pool, id);
  }

  async listSignals(f: SignalFilter): Promise<Signal[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.deviceId !== undefined) {
      where.push("device_id = ?");
      params.push(toNo(f.deviceId));
    }
    if (f.codes !== undefined) {
      if (!f.codes.length) return [];
      where.push("code IN (?)");
      params.push(f.codes);
    }
    if (f.unhandledOnly) where.push("handled_at IS NULL");
    if (f.from) {
      where.push("received_at >= ?");
      params.push(f.from);
    }
    if (f.to) {
      where.push("received_at < ?");
      params.push(f.to);
    }
    params.push(f.limit);
    const list = await rows<SignalRow>(
      this.pool,
      `SELECT * FROM signals ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY received_at DESC, id DESC LIMIT ?`,
      params,
    );
    return list.map(toSignal);
  }

  async handleSignal(id: number, at: Date): Promise<Signal | null> {
    await exec(this.pool, "UPDATE signals SET handled_at = ? WHERE id = ? AND handled_at IS NULL", [at, id]);
    return this.getSignal(id);
  }

  // ---- 端末 ----

  async recordStatus(u: StatusUpdate): Promise<void> {
    const no = toNo(u.deviceId);
    await this.tx(async (c) => {
      const wasOnline = await lockDevice(c, no, u.receivedAt);
      await exec(
        c,
        `UPDATE devices SET battery = COALESCE(?, battery), has_glass = COALESCE(?, has_glass),
                via = COALESCE(?, via), lat = COALESCE(?, lat), lon = COALESCE(?, lon) WHERE id = ?`,
        [u.battery ?? null, u.glass ?? null, u.via ?? null, u.lat ?? null, u.lon ?? null, no],
      );
      await markSeen(c, no, u.receivedAt, wasOnline, u.battery);
    });
  }

  async touchDevice(deviceId: DeviceId, at: Date): Promise<void> {
    const no = toNo(deviceId);
    await this.tx(async (c) => {
      const wasOnline = await lockDevice(c, no, at);
      await markSeen(c, no, at, wasOnline);
    });
  }

  async markOffline(deviceId: DeviceId, cause: OfflineCause, at: Date, seenBefore?: Date): Promise<boolean> {
    const no = toNo(deviceId);
    const r = await exec(
      this.pool,
      `UPDATE devices SET is_online = FALSE WHERE id = ? AND is_online
          ${seenBefore ? "AND (last_seen_at IS NULL OR last_seen_at < ?)" : ""}`,
      seenBefore ? [no, seenBefore] : [no],
    );
    if (!r.affectedRows) return false;
    await exec(this.pool, "INSERT INTO device_events (device_id, kind, created_at) VALUES (?, ?, ?)", [no, cause, at]);
    return true;
  }

  async registerDevice(deviceId: DeviceId, owner: string | null, at: Date): Promise<Device> {
    const no = toNo(deviceId);
    await exec(
      this.pool,
      `INSERT INTO devices (id, owner_name, registered, created_at) VALUES (?, ?, TRUE, ?) AS new
         ON DUPLICATE KEY UPDATE owner_name = new.owner_name, registered = TRUE`,
      [no, owner, at],
    );
    const d = await this.getDevice(deviceId);
    if (!d) throw new Error("登録した端末が読めない");
    return d;
  }

  async updateOwner(deviceId: DeviceId, owner: string | null): Promise<Device | null> {
    if (!(await this.getDevice(deviceId))) return null;
    await exec(this.pool, "UPDATE devices SET owner_name = ? WHERE id = ?", [owner, toNo(deviceId)]);
    return this.getDevice(deviceId);
  }

  async getDevice(deviceId: DeviceId): Promise<Device | null> {
    const [r] = await rows<DeviceRow>(this.pool, "SELECT * FROM devices WHERE id = ?", [toNo(deviceId)]);
    return r ? toDevice(r) : null;
  }

  async listDevices(): Promise<Device[]> {
    return (await rows<DeviceRow>(this.pool, "SELECT * FROM devices ORDER BY id")).map(toDevice);
  }

  // ---- 一覧表 ----

  async listPositions(): Promise<Position[]> {
    return (await rows<PositionRow>(this.pool, "SELECT * FROM positions ORDER BY id")).map(toPosition);
  }

  async createPosition(p: PositionInput, at: Date): Promise<Position | null> {
    try {
      await exec(this.pool, "INSERT INTO positions (id, name, note, lat, lon, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [
        p.no,
        p.name,
        p.place,
        p.lat,
        p.lon,
        at,
      ]);
    } catch (err) {
      if (isDuplicate(err)) return null;
      throw err;
    }
    return this.positionByNo(p.no);
  }

  async updatePosition(p: PositionInput, at: Date): Promise<Position | null> {
    if (!(await this.positionByNo(p.no))) return null;
    await exec(this.pool, "UPDATE positions SET name = ?, note = ?, lat = ?, lon = ?, updated_at = ? WHERE id = ?", [
      p.name,
      p.place,
      p.lat,
      p.lon,
      at,
      p.no,
    ]);
    return this.positionByNo(p.no);
  }

  async deletePosition(no: number): Promise<boolean> {
    return (await exec(this.pool, "DELETE FROM positions WHERE id = ?", [no])).affectedRows > 0;
  }

  async listSignalCodes(): Promise<SignalCode[]> {
    return (await rows<SignalCodeRow>(this.pool, "SELECT * FROM signal_codes ORDER BY code")).map((r) => ({
      code: r.code,
      name: r.name,
      shortName: r.short_name,
      glassText: r.glass_text,
      positionRule: r.position_rule,
      quantityRule: r.quantity_rule,
      quantityUnit: r.quantity_unit,
      hasDirection: Boolean(r.has_direction),
      priority: r.priority,
      isSos: Boolean(r.is_sos),
    }));
  }

  async listInstructionCodes(): Promise<InstructionCode[]> {
    return (await rows<InstructionCodeRow>(this.pool, "SELECT * FROM instruction_codes ORDER BY code")).map(
      toInstructionCode,
    );
  }

  async createInstructionCode(code: InstructionCode): Promise<InstructionCode | null> {
    try {
      await exec(
        this.pool,
        `INSERT INTO instruction_codes (code, name, uses_position, text_with_pos, text_without_pos, requires_response, strength)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [code.code, code.name, code.usesPosition, code.textWithPos, code.textWithoutPos, code.requiresResponse, code.strength],
      );
    } catch (err) {
      if (isDuplicate(err)) return null;
      throw err;
    }
    return this.instructionCodeByNo(code.code);
  }

  async updateInstructionCode(code: InstructionCode): Promise<InstructionCode | null> {
    if (!(await this.instructionCodeByNo(code.code))) return null;
    await exec(
      this.pool,
      `UPDATE instruction_codes SET name = ?, uses_position = ?, text_with_pos = ?, text_without_pos = ?,
              requires_response = ?, strength = ? WHERE code = ?`,
      [code.name, code.usesPosition, code.textWithPos, code.textWithoutPos, code.requiresResponse, code.strength, code.code],
    );
    return this.instructionCodeByNo(code.code);
  }

  // ---- 本部から送ったもの ----

  async createMessage(m: NewMessage, targets: MessageTarget[]): Promise<Message> {
    return this.tx(async (c) => {
      // 宛先の端末は外部キーで devices を指すので、無ければ作る(registered = false)
      const nos = new Set(targets.map((t) => toNo(t.deviceId)));
      if (m.dst !== "all") nos.add(toNo(m.dst));
      for (const no of nos) await ensureDevice(c, no, m.sentAt);

      const kind = m.kind === "order" ? "instruction" : m.source === "transcript" ? "transcript" : "text";
      const ins = await exec(
        c,
        `INSERT INTO messages (kind, dst_device_id, body, instruction_code, position_id, seq, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          kind,
          m.dst === "all" ? null : toNo(m.dst),
          m.body,
          m.kind === "order" ? (m.icode ?? null) : null,
          m.kind === "order" ? m.pos || null : null,
          m.seq,
          m.sentAt,
        ],
      );
      if (targets.length) {
        await exec(c, "INSERT INTO message_deliveries (message_id, device_id, via_at_send, is_skipped) VALUES ?", [
          targets.map((t) => [ins.insertId, toNo(t.deviceId), t.viaAtSend, t.skipped ?? false]),
        ]);
      }
      const saved = await messageById(c, ins.insertId);
      if (!saved) throw new Error("保存した messages が読めない");
      return saved;
    });
  }

  async setPublishState(messageId: number, state: PublishState): Promise<void> {
    await exec(this.pool, "UPDATE messages SET publish_state = ? WHERE id = ?", [state, messageId]);
  }

  async getMessage(messageId: number): Promise<Message | null> {
    return messageById(this.pool, messageId);
  }

  async listMessages(f: MessageFilter): Promise<Message[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.deviceId !== undefined) {
      where.push("EXISTS (SELECT 1 FROM message_deliveries md WHERE md.message_id = m.id AND md.device_id = ?)");
      params.push(toNo(f.deviceId));
    }
    if (f.from) {
      where.push("m.sent_at >= ?");
      params.push(f.from);
    }
    if (f.to) {
      where.push("m.sent_at < ?");
      params.push(f.to);
    }
    params.push(f.limit);
    const list = await rows<MessageRow>(
      this.pool,
      `SELECT m.* FROM messages m ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY m.sent_at DESC, m.id DESC LIMIT ?`,
      params,
    );
    return list.map(toMessage);
  }

  async getLastMessageSeq(): Promise<number | null> {
    const [r] = await rows<{ seq: number }>(this.pool, "SELECT seq FROM messages ORDER BY id DESC LIMIT 1");
    return r ? r.seq : null;
  }

  async findMessagesBySeq(seq: number, since: Date): Promise<Message[]> {
    const list = await rows<MessageRow>(
      this.pool,
      "SELECT * FROM messages WHERE seq = ? AND sent_at > ? ORDER BY sent_at DESC, id DESC",
      [seq, since],
    );
    return list.map(toMessage);
  }

  // ---- 届いた確認 ----

  async recordAck(
    messageId: number,
    deviceId: DeviceId,
    ackedAt: Date,
    response?: AckResponse,
  ): Promise<RecordAckResult> {
    const no = toNo(deviceId);
    // 最初の時刻・最初の返事だけを残す(IS NULL のときだけ書く)
    const received = await exec(
      this.pool,
      "UPDATE message_deliveries SET received_at = ? WHERE message_id = ? AND device_id = ? AND received_at IS NULL",
      [ackedAt, messageId, no],
    );
    const responded = response
      ? await exec(
          this.pool,
          `UPDATE message_deliveries SET response = ?, responded_at = ?
            WHERE message_id = ? AND device_id = ? AND response IS NULL`,
          [response, ackedAt, messageId, no],
        )
      : undefined;
    if (received.affectedRows || responded?.affectedRows) return { kind: "saved" };
    const exists = await rows(this.pool, "SELECT 1 FROM message_deliveries WHERE message_id = ? AND device_id = ?", [
      messageId,
      no,
    ]);
    return { kind: exists.length ? "duplicate" : "not_target" };
  }

  async getDeliveries(messageId: number): Promise<Delivery[]> {
    return (await this.listDeliveries([messageId])).get(messageId) ?? [];
  }

  async listDeliveries(messageIds: number[]): Promise<Map<number, Delivery[]>> {
    const out = new Map<number, Delivery[]>();
    if (!messageIds.length) return out;
    for (const id of messageIds) out.set(id, []);
    const list = await rows<DeliveryRow>(
      this.pool,
      "SELECT * FROM message_deliveries WHERE message_id IN (?) ORDER BY message_id, device_id",
      [messageIds],
    );
    for (const r of list) {
      out.get(Number(r.message_id))?.push({
        deviceId: formatDeviceId(r.device_id),
        viaAtSend: r.via_at_send,
        skipped: Boolean(r.is_skipped),
        ackedAt: r.received_at,
        response: r.response,
        respondedAt: r.responded_at,
      });
    }
    return out;
  }

  // ---- 内部 ----

  /** トランザクションの中で fn を流す。デッドロックで負けたら数回やり直す */
  private async tx<T>(fn: (c: PoolConnection) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const c = await this.pool.getConnection();
      try {
        await c.beginTransaction();
        const result = await fn(c);
        await c.commit();
        return result;
      } catch (err) {
        await c.rollback().catch(() => undefined);
        if (attempt < 4 && RETRY_ERRORS.has((err as { code?: string }).code ?? "")) continue;
        throw err;
      } finally {
        c.release();
      }
    }
  }

  private async signalById(q: Queryable, id: number): Promise<Signal | null> {
    const [r] = await rows<SignalRow>(q, "SELECT * FROM signals WHERE id = ?", [id]);
    return r ? toSignal(r) : null;
  }

  private async positionByNo(no: number): Promise<Position | null> {
    const [r] = await rows<PositionRow>(this.pool, "SELECT * FROM positions WHERE id = ?", [no]);
    return r ? toPosition(r) : null;
  }

  private async instructionCodeByNo(code: number): Promise<InstructionCode | null> {
    const [r] = await rows<InstructionCodeRow>(this.pool, "SELECT * FROM instruction_codes WHERE code = ?", [code]);
    return r ? toInstructionCode(r) : null;
  }
}

// ---- SQL の道具 ----

async function rows<T = Record<string, unknown>>(q: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const [r] = await q.query<RowDataPacket[]>(sql, params);
  return r as unknown as T[];
}

async function exec(q: Queryable, sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const [r] = await q.query<ResultSetHeader>(sql, params);
  return r;
}

/** 無ければ registered = false で作る(あれば何もしない) */
async function ensureDevice(c: Queryable, no: number, at: Date): Promise<void> {
  await exec(c, "INSERT INTO devices (id, created_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = id", [no, at]);
}

/** 行を作ってから鍵をかけ、今つながっているかを返す */
async function lockDevice(c: PoolConnection, no: number, at: Date): Promise<boolean> {
  await ensureDevice(c, no, at);
  const [r] = await rows<{ is_online: number }>(c, "SELECT is_online FROM devices WHERE id = ? FOR UPDATE", [no]);
  return Boolean(r?.is_online);
}

/**
 * 届いた時刻が今の last_seen_at より新しいときだけ、last_seen_at と online を進める
 * (出口に溜まっていた古いものが後から届いても、「つながった」にはしない)。
 * 切れていた端末がつながったら device_events に online を残す
 */
async function markSeen(c: PoolConnection, no: number, at: Date, wasOnline: boolean, battery?: number): Promise<void> {
  const r = await exec(
    c,
    "UPDATE devices SET last_seen_at = ?, is_online = TRUE WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)",
    [at, no, at],
  );
  if (r.affectedRows && !wasOnline) {
    await exec(c, "INSERT INTO device_events (device_id, kind, battery, created_at) VALUES (?, 'online', ?, ?)", [
      no,
      battery ?? null,
      at,
    ]);
  }
}

async function messageById(q: Queryable, id: number): Promise<Message | null> {
  const [r] = await rows<MessageRow>(q, "SELECT * FROM messages WHERE id = ?", [id]);
  return r ? toMessage(r) : null;
}

function isDuplicate(err: unknown): boolean {
  return (err as { code?: string }).code === "ER_DUP_ENTRY";
}

/** `dev-001` → 1。窓口に入る前に確かめてあるはずなので、形が違えば作りの誤り */
function toNo(id: DeviceId): number {
  const no = deviceNumber(id);
  if (no === null) throw new Error(`端末ID の形が違う: ${id}`);
  return no;
}

// ---- 行 ⇔ 窓口の形 ----

interface DeviceRow {
  id: number;
  owner_name: string | null;
  registered: number;
  position_id: number | null;
  is_online: number;
  via: Via | null;
  battery: number | null;
  has_glass: number | null;
  lat: number | null;
  lon: number | null;
  last_seen_at: Date | null;
  created_at: Date;
}

function toDevice(r: DeviceRow): Device {
  return {
    id: formatDeviceId(r.id),
    owner: r.owner_name,
    online: Boolean(r.is_online),
    via: r.via,
    battery: r.battery,
    glass: r.has_glass === null ? null : Boolean(r.has_glass),
    pos: r.position_id,
    lat: r.lat,
    lon: r.lon,
    lastSeenAt: r.last_seen_at,
    createdAt: r.created_at,
    registered: Boolean(r.registered),
  };
}

interface SignalRow {
  id: number;
  device_id: number;
  seq: number;
  code: number;
  position_id: number | null;
  quantity: number | null;
  direction: number | null;
  is_out_of_range: number;
  via: Via | null;
  device_ts: Date | null;
  received_at: Date;
  handled_at: Date | null;
}

function toSignal(r: SignalRow): Signal {
  return {
    id: Number(r.id),
    deviceId: formatDeviceId(r.device_id),
    seq: r.seq,
    code: r.code,
    pos: r.position_id ?? 0,
    ...(r.quantity !== null && { n: r.quantity }),
    ...(r.direction !== null && { dir: r.direction }),
    via: r.via,
    deviceTs: r.device_ts,
    receivedAt: r.received_at,
    outOfRange: Boolean(r.is_out_of_range),
    handledAt: r.handled_at,
  };
}

interface PositionRow {
  id: number;
  name: string;
  note: string | null;
  lat: number | null;
  lon: number | null;
  updated_at: Date;
}

function toPosition(r: PositionRow): Position {
  return { no: r.id, name: r.name, place: r.note, lat: r.lat, lon: r.lon, updatedAt: r.updated_at };
}

interface SignalCodeRow {
  code: number;
  name: string;
  short_name: string;
  glass_text: string;
  position_rule: Rule;
  quantity_rule: Rule;
  quantity_unit: string | null;
  has_direction: number;
  priority: SignalCode["priority"];
  is_sos: number;
}

interface InstructionCodeRow {
  code: number;
  name: string;
  uses_position: number;
  text_with_pos: string | null;
  text_without_pos: string | null;
  requires_response: number;
  strength: InstructionCode["strength"];
}

function toInstructionCode(r: InstructionCodeRow): InstructionCode {
  return {
    code: r.code,
    name: r.name,
    usesPosition: Boolean(r.uses_position),
    textWithPos: r.text_with_pos,
    textWithoutPos: r.text_without_pos,
    requiresResponse: Boolean(r.requires_response),
    strength: r.strength,
  };
}

interface MessageRow {
  id: number;
  kind: "text" | "instruction" | "transcript";
  dst_device_id: number | null;
  body: string | null;
  instruction_code: number | null;
  position_id: number | null;
  seq: number;
  publish_state: PublishState | null;
  sent_at: Date;
}

function toMessage(r: MessageRow): Message {
  const order = r.kind === "instruction";
  return {
    id: Number(r.id),
    seq: r.seq,
    dst: r.dst_device_id === null ? "all" : formatDeviceId(r.dst_device_id),
    body: r.body ?? "",
    kind: order ? "order" : "free",
    ...(order && { icode: r.instruction_code ?? 0, pos: r.position_id ?? 0 }),
    source: r.kind === "transcript" ? "transcript" : "web",
    sentAt: r.sent_at,
    publishState: r.publish_state,
  };
}

interface DeliveryRow {
  message_id: number;
  device_id: number;
  via_at_send: ViaAtSend;
  is_skipped: number;
  received_at: Date | null;
  response: AckResponse | null;
  responded_at: Date | null;
}
