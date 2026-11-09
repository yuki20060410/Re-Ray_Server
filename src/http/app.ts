// HTTP API(Fastify。INTERFACES §4)と、管理画面(web/)の配信
//
// - JSON、UTF-8、接頭辞は /api。検証版は認証なし(ローカル LAN のみ。README §9)
// - エラーは {"error": "コード", "message": "画面に出す文"}(INTERFACES §4.4)
// - 保存は窓口(Storage)、送信は Sender を通す。ここは「確かめて、呼んで、形を直す」だけ
// 2026-11-06 作成(reray-app の server.js の API を、INTERFACES の形に合わせて取り込んだ)

import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { deviceNumber } from "../protocol/topics.js";
import { BODY_MAX, SendError, type Sender } from "../server/sender.js";
import type { InstructionCode, PositionInput, Storage, Via } from "../storage/types.js";
import {
  deviceView,
  instructionCodeView,
  iso,
  messageView,
  positionView,
  signalCodeView,
  signalView,
  type Refs,
} from "./views.js";

/** テスト用の操作(管理画面の「テスト用」の欄。DEV_TOOLS=1 のときだけ) */
export interface DevTools {
  /** 偽の端末から定型信号を送る。偽の端末がつながっていなければ、MQTT を通さず届いたことにする */
  signal(deviceId: string, code: number, n?: number): Promise<{ sent: "mqtt" | "direct"; seq: number }>;
  /** 偽の端末を黙って切る(遺言が流れる)/つなぐ */
  toggleOnline(deviceId: string): Promise<"connected" | "dropped">;
  /** 偽の端末の経路を Wi-Fi / LoRa に切り替える */
  toggleVia(deviceId: string): Promise<Via>;
}

export interface AppDeps {
  storage: Storage;
  sender: Sender;
  isMqttConnected: () => boolean;
  storageKind: "memory" | "mysql";
  /** 管理画面のフォルダ。null なら配らない */
  webDir: string | null;
  dev: DevTools | null;
  now?: () => Date;
  logger?: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const bad = (message: string, code = "bad_request"): never => {
  throw new ApiError(400, code, message);
};
const invalid = (message: string, code: string): never => {
  throw new ApiError(422, code, message);
};
const notFound = (message: string): never => {
  throw new ApiError(404, "not_found", message);
};

const LOG_LIMIT_MAX = 500;
const SOS_LIMIT = 1000;

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { storage, sender } = deps;
  const now = deps.now ?? (() => new Date());
  const app = Fastify({ logger: deps.logger ?? false });

  // ---- 道具 ----

  async function refs(): Promise<Refs> {
    const [positions, signalCodes, instructionCodes, devices] = await Promise.all([
      storage.listPositions(),
      storage.listSignalCodes(),
      storage.listInstructionCodes(),
      storage.listDevices(),
    ]);
    return {
      positions: new Map(positions.map((p) => [p.no, p])),
      signalCodes: new Map(signalCodes.map((c) => [c.code, c])),
      instructionCodes: new Map(instructionCodes.map((c) => [c.code, c])),
      owners: new Map(devices.map((d) => [d.id, d.owner])),
    };
  }

  const sosCodes = (r: Refs) => [...r.signalCodes.values()].filter((c) => c.isSos).map((c) => c.code);

  async function deviceViews(ids?: string[]) {
    const r = await refs();
    const devices = (await storage.listDevices()).filter((d) => !ids || ids.includes(d.id));
    const [last, sos] = await Promise.all([
      storage.getLastSignals(devices.map((d) => d.id)),
      storage.listSignals({ codes: sosCodes(r), unhandledOnly: true, limit: SOS_LIMIT }),
    ]);
    return devices.map((d) =>
      deviceView(r, d, last.get(d.id), sos.filter((s) => s.deviceId === d.id)),
    );
  }

  async function messageViews(ids: number[], withDevices: boolean) {
    const r = await refs();
    const deliveries = await storage.listDeliveries(ids);
    const out = [];
    for (const id of ids) {
      const m = await storage.getMessage(id);
      if (m) out.push(messageView(r, m, deliveries.get(id) ?? [], withDevices));
    }
    return out;
  }

  // ---- エラーの形 ----

  app.setErrorHandler((err: unknown, _req, reply: FastifyReply) => {
    if (err instanceof ApiError || err instanceof SendError) {
      return reply.status(err.status).send({ error: err.code, message: err.message });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: "bad_request", message: "送られてきた中身が読めません(JSON の形を確かめてください)" });
    }
    app.log.error(err);
    console.error(err);
    return reply.status(500).send({ error: "internal", message: "サーバーの中でエラーが起きました" });
  });

  // ---- 状態【追加案】 ----

  app.get("/api/health", async () => ({
    ok: true,
    mqtt: deps.isMqttConnected(),
    storage: deps.storageKind,
    now: iso(now()),
  }));

  // ---- 端末(W2・W3・W6) ----

  app.get("/api/devices", async () => deviceViews());

  app.get<{ Params: { id: string } }>("/api/devices/:id", async (req) => {
    const id = deviceIdParam(req.params.id);
    const [d] = await deviceViews([id]);
    return d ?? notFound(`${id} はありません`);
  });

  app.post<{ Body: { id?: unknown; owner?: unknown } }>("/api/devices", async (req, reply) => {
    const id = deviceIdParam(req.body?.id);
    const owner = ownerParam(req.body?.owner);
    const existing = await storage.getDevice(id);
    if (existing?.registered) invalid(`${id} はもう登録されています`, "already_registered");
    await storage.registerDevice(id, owner, now());
    const [d] = await deviceViews([id]);
    return reply.status(201).send(d);
  });

  app.put<{ Params: { id: string }; Body: { owner?: unknown } }>("/api/devices/:id", async (req) => {
    const id = deviceIdParam(req.params.id);
    const owner = ownerParam(req.body?.owner);
    if (!(await storage.updateOwner(id, owner))) notFound(`${id} はありません`);
    const [d] = await deviceViews([id]);
    return d;
  });

  // ---- ポジション(W8)【案】 ----

  app.get("/api/positions", async () => (await storage.listPositions()).map(positionView));

  app.post<{ Body: Record<string, unknown> }>("/api/positions", async (req, reply) => {
    const p = positionParam(req.body?.no, req.body ?? {});
    const saved = await storage.createPosition(p, now());
    if (!saved) invalid(`ポジション ${p.no} はもうあります`, "duplicate_position");
    return reply.status(201).send(positionView(saved!));
  });

  app.put<{ Params: { no: string }; Body: Record<string, unknown> }>("/api/positions/:no", async (req) => {
    const p = positionParam(req.params.no, req.body ?? {});
    const saved = await storage.updatePosition(p, now());
    return saved ? positionView(saved) : notFound(`ポジション ${p.no} はありません`);
  });

  app.delete<{ Params: { no: string } }>("/api/positions/:no", async (req, reply) => {
    const no = intParam(req.params.no, 1, 255, "ポジションの番号は 1〜255 です");
    if (!(await storage.deletePosition(no))) notFound(`ポジション ${no} はありません`);
    return reply.status(204).send();
  });

  // ---- 定型信号・指示コードの一覧【案】 ----

  app.get("/api/signal-codes", async () => (await storage.listSignalCodes()).map(signalCodeView));

  app.get("/api/instruction-codes", async () => (await storage.listInstructionCodes()).map(instructionCodeView));

  app.post<{ Body: Record<string, unknown> }>("/api/instruction-codes", async (req, reply) => {
    const c = instructionCodeParam(req.body?.code, req.body ?? {});
    const saved = await storage.createInstructionCode(c);
    if (!saved) invalid(`指示コード ${c.code} はもうあります`, "duplicate_icode");
    return reply.status(201).send(instructionCodeView(saved!));
  });

  app.put<{ Params: { code: string }; Body: Record<string, unknown> }>("/api/instruction-codes/:code", async (req) => {
    const c = instructionCodeParam(req.params.code, req.body ?? {});
    const saved = await storage.updateInstructionCode(c);
    return saved ? instructionCodeView(saved) : notFound(`指示コード ${c.code} はありません`);
  });

  // ---- 送る(W3・W4。M3) ----

  app.post<{ Body: Record<string, unknown> }>("/api/messages", async (req, reply) => {
    const b = req.body ?? {};
    const dst = typeof b.dst === "string" ? b.dst : bad("送り先(dst)を入れてください");
    const m =
      b.icode !== undefined && b.icode !== null
        ? await sender.send({ dst, kind: "order", icode: Number(b.icode), pos: Number(b.pos ?? 0) })
        : await sender.send({ dst, kind: "free", body: typeof b.body === "string" ? b.body : "" });
    return reply.status(201).send({ id: m.id });
  });

  // 文字起こしの入口(災害用。INTERFACES §4.3)【案】。transcripts の表は作らず、messages の source で区別する
  app.post<{ Body: Record<string, unknown> }>("/api/transcripts", async (req, reply) => {
    const b = req.body ?? {};
    const dst = typeof b.dst === "string" ? b.dst : bad("送り先(dst)を入れてください");
    const m = await sender.send({
      dst,
      kind: "free",
      body: typeof b.body === "string" ? b.body : "",
      source: "transcript",
    });
    return reply.status(201).send({ id: m.id });
  });

  app.get<{ Querystring: { limit?: string } }>("/api/messages", async (req) => {
    const limit = limitParam(req.query.limit, 10, 100);
    const list = await storage.listMessages({ limit });
    return messageViews(list.map((m) => m.id), false);
  });

  app.get<{ Params: { id: string } }>("/api/messages/:id", async (req) => {
    const id = intParam(req.params.id, 1, Number.MAX_SAFE_INTEGER, "番号が正しくありません");
    const [v] = await messageViews([id], true);
    return v ?? notFound("その送信の記録はありません");
  });

  // ---- 記録(W3・W5) ----
  // type: signal / sos / message(省略で全部)。from・to は ISO 8601。新しい順

  app.get<{ Querystring: Record<string, string | undefined> }>("/api/logs", async (req) => {
    const q = req.query;
    const deviceId = q.device ? deviceIdParam(q.device) : undefined;
    const type = q.type || undefined;
    if (type && !["signal", "sos", "message"].includes(type)) bad("種類(type)は signal・sos・message のどれかです");
    const from = dateParam(q.from, "from");
    const to = dateParam(q.to, "to");
    const limit = limitParam(q.limit, 200, LOG_LIMIT_MAX);
    const r = await refs();
    const range = { ...(deviceId && { deviceId }), ...(from && { from }), ...(to && { to }), limit };

    const items: { type: "signal" | "message"; at: string | null; signal?: unknown; message?: unknown }[] = [];
    if (type !== "message") {
      const signals = await storage.listSignals({ ...range, ...(type === "sos" && { codes: sosCodes(r) }) });
      for (const s of signals) items.push({ type: "signal", at: iso(s.receivedAt), signal: signalView(r, s) });
    }
    if (!type || type === "message") {
      const messages = await storage.listMessages(range);
      const ds = await storage.listDeliveries(messages.map((m) => m.id));
      for (const m of messages) {
        items.push({ type: "message", at: iso(m.sentAt), message: messageView(r, m, ds.get(m.id) ?? [], false) });
      }
    }
    // 時刻の文字列は同じ時間帯・同じ桁なので、文字の順 = 時刻の順
    return items.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "")).slice(0, limit);
  });

  // ---- SOS(どの画面でも知らせる)【案】 ----

  app.get("/api/sos", async () => {
    const r = await refs();
    const list = await storage.listSignals({ codes: sosCodes(r), unhandledOnly: true, limit: SOS_LIMIT });
    return list.map((s) => signalView(r, s));
  });

  app.post<{ Params: { id: string } }>("/api/signals/:id/handle", async (req) => {
    const id = intParam(req.params.id, 1, Number.MAX_SAFE_INTEGER, "番号が正しくありません");
    const s = await storage.handleSignal(id, now());
    return s ? signalView(await refs(), s) : notFound("その信号はありません");
  });

  // ---- テスト用(DEV_TOOLS=1 のときだけ)【追加案】 ----

  if (deps.dev) {
    const dev = deps.dev;
    app.post<{ Body: Record<string, unknown> }>("/api/dev/signal", async (req) => {
      const b = req.body ?? {};
      const id = deviceIdParam(b.device);
      const code = intParam(b.code, 1, 31, "定型信号の番号は 1〜31 です");
      const n = b.n === undefined || b.n === null || b.n === "" ? undefined : intParam(b.n, 0, 255, "数量は 0〜255 です");
      return dev.signal(id, code, n);
    });
    app.post<{ Params: { id: string } }>("/api/dev/devices/:id/toggle-online", async (req) => {
      const id = deviceIdParam(req.params.id);
      return { id, result: await dev.toggleOnline(id) };
    });
    app.post<{ Params: { id: string } }>("/api/dev/devices/:id/toggle-via", async (req) => {
      const id = deviceIdParam(req.params.id);
      return { id, via: await dev.toggleVia(id) };
    });
  }

  app.all("/api/*", async () => notFound("その API はありません"));

  // ---- 管理画面 ----

  if (deps.webDir && existsSync(deps.webDir)) {
    // 画面に「本物のサーバーで開いている」ことを知らせる(web/serve.js で開いたときは web/js/mode.js が使われる)
    app.get("/js/mode.js", async (_req, reply) =>
      reply
        .type("text/javascript; charset=utf-8")
        .header("Cache-Control", "no-store")
        .send(
          `CONFIG.API_MODE = 'server';\nCONFIG.DEV_TOOLS = ${deps.dev ? "true" : "false"};\nCONFIG.BODY_MAX = ${BODY_MAX};\n`,
        ),
    );
    await app.register(fastifyStatic, { root: deps.webDir, cacheControl: false, etag: false, lastModified: false });
  }

  return app;
}

// ---- 入力の確かめ ----

function deviceIdParam(v: unknown): string {
  if (typeof v !== "string" || deviceNumber(v) === null) {
    return bad("端末ID は dev-001 の形で入れてください(番号は 1〜65534)", "bad_device_id");
  }
  return v;
}

function ownerParam(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return bad("名前は文字で入れてください");
  const s = v.trim();
  if ([...s].length > 30) invalid("名前は30文字までです", "owner_too_long");
  return s || null;
}

function intParam(v: unknown, min: number, max: number, message: string): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (!Number.isInteger(n) || (n as number) < min || (n as number) > max) return bad(message);
  return n as number;
}

function limitParam(v: string | undefined, def: number, max: number): number {
  if (v === undefined || v === "") return def;
  return intParam(v, 1, max, `件数(limit)は 1〜${max} です`);
}

function dateParam(v: string | undefined, name: string): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return bad(`${name} は ISO 8601 の日時で入れてください`);
  return d;
}

function textParam(v: unknown, max: number, label: string, required: boolean): string | null {
  if (v === undefined || v === null || v === "") {
    if (required) invalid(`${label}を入れてください`, "missing");
    return null;
  }
  if (typeof v !== "string") return bad(`${label}は文字で入れてください`);
  const s = v.trim();
  if (!s && required) invalid(`${label}を入れてください`, "missing");
  if ([...s].length > max) invalid(`${label}は${max}文字までです`, "too_long");
  return s || null;
}

function numberOrNull(v: unknown, min: number, max: number, label: string): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return invalid(`${label}が正しくありません`, "bad_number");
  return n;
}

function positionParam(no: unknown, b: Record<string, unknown>): PositionInput {
  return {
    no: intParam(no, 1, 255, "ポジションの番号は 1〜255 です"),
    name: textParam(b.name, 30, "名前", true)!,
    place: textParam(b.place, 100, "場所の説明", false),
    lat: numberOrNull(b.lat, -90, 90, "緯度"),
    lon: numberOrNull(b.lon, -180, 180, "経度"),
  };
}

function instructionCodeParam(code: unknown, b: Record<string, unknown>): InstructionCode {
  const usesPosition = b.uses_position === true;
  const strength = b.strength ?? null;
  if (strength !== null && !["required", "request", "report"].includes(String(strength))) {
    bad("strength は required・request・report のどれかです");
  }
  return {
    code: intParam(code, 1, 255, "指示コードは 1〜255 です"),
    name: textParam(b.name, 20, "名前", true)!,
    usesPosition,
    textWithPos: textParam(b.text_with_pos, 40, "ポジションありの文", usesPosition),
    textWithoutPos: textParam(b.text_without_pos, 40, "ポジションなしの文", !usesPosition),
    requiresResponse: b.requires_response !== false,
    strength: strength as InstructionCode["strength"],
  };
}
