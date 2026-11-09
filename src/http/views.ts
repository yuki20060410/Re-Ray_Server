// API が返す JSON の形(INTERFACES §4。項目名は snake_case、時刻は日本時間 +09:00 の ISO 8601)
//
// 保存の窓口の形(camelCase・Date)から、画面に渡す形に直す。何台に届いたかの数え方もここで決める。
// 2026-11-06 作成。INTERFACES §4.1 の形に、reray-app の管理画面が使っていた項目を【案】で足した
//   (last_seen_at、open_sos、signal の id・is_sos・handled_at・out_of_range、届き具合の summary など)

import type {
  Delivery,
  Device,
  InstructionCode,
  Message,
  Position,
  Signal,
  SignalCode,
} from "../storage/types.js";

/** 画面に出す時間帯(INTERFACES §4.1: 時刻は ISO 8601。表示は日本時間) */
const DISPLAY_OFFSET_MS = 9 * 60 * 60 * 1000;

export function iso(d: Date | null | undefined): string | null {
  if (!d) return null;
  return new Date(d.getTime() + DISPLAY_OFFSET_MS).toISOString().replace("Z", "+09:00");
}

/** 名前を引くための一覧(1 回の API 呼び出しで 1 回だけ読む) */
export interface Refs {
  positions: Map<number, Position>;
  signalCodes: Map<number, SignalCode>;
  instructionCodes: Map<number, InstructionCode>;
  owners: Map<string, string | null>;
}

export function positionRef(refs: Refs, no: number | null | undefined) {
  if (!no) return null;
  return { no, name: refs.positions.get(no)?.name ?? null };
}

export function signalView(refs: Refs, s: Signal) {
  return {
    id: s.id,
    device: s.deviceId,
    owner: refs.owners.get(s.deviceId) ?? null,
    seq: s.seq,
    code: s.code,
    /** SOS か(一覧の is_sos。一覧に無い番号は false) */
    is_sos: refs.signalCodes.get(s.code)?.isSos ?? false,
    pos: s.pos,
    position: positionRef(refs, s.pos),
    n: s.n ?? null,
    dir: s.dir ?? null,
    via: s.via,
    out_of_range: s.outOfRange,
    at: iso(s.receivedAt),
    device_ts: iso(s.deviceTs),
    handled_at: iso(s.handledAt),
  };
}

export type SignalView = ReturnType<typeof signalView>;

export function deviceView(refs: Refs, d: Device, last: Signal | undefined, openSos: Signal[]) {
  return {
    id: d.id,
    owner: d.owner,
    registered: d.registered,
    online: d.online,
    via: d.via,
    battery: d.battery,
    glass: d.glass,
    position: positionRef(refs, d.pos),
    lat: d.lat,
    lon: d.lon,
    last_seen_at: iso(d.lastSeenAt),
    created_at: iso(d.createdAt),
    last_signal: last ? signalView(refs, last) : null,
    open_sos: openSos.map((s) => signalView(refs, s)),
  };
}

export function positionView(p: Position) {
  return { no: p.no, name: p.name, place: p.place, lat: p.lat, lon: p.lon, updated_at: iso(p.updatedAt) };
}

export function signalCodeView(c: SignalCode) {
  return {
    code: c.code,
    name: c.name,
    short_name: c.shortName,
    glass_text: c.glassText,
    position_rule: c.positionRule,
    quantity_rule: c.quantityRule,
    quantity_unit: c.quantityUnit,
    has_direction: c.hasDirection,
    priority: c.priority,
    is_sos: c.isSos,
  };
}

export function instructionCodeView(c: InstructionCode) {
  return {
    code: c.code,
    name: c.name,
    uses_position: c.usesPosition,
    text_with_pos: c.textWithPos,
    text_without_pos: c.textWithoutPos,
    requires_response: c.requiresResponse,
    strength: c.strength,
  };
}

/**
 * 何台に届いたか(INTERFACES §4.1、DATA_MODEL §6)
 * - wifi / lora / offline: 送った時の経路ごとの宛先の数と、届いた数(INTERFACES の形 + offline【案】)
 * - summary【案】: 画面にそのまま出す数。waiting = まだ届いていない(送らなかった・切れていた端末は除く)、
 *   lora = LoRa 中で運んだもの(指示コード)、skipped = 自由な文で LoRa 中だったので運ばなかったもの
 */
export function deliveryCounts(ds: Delivery[]) {
  const group = (via: string) => {
    const g = ds.filter((d) => d.viaAtSend === via);
    return { total: g.length, acked: g.filter((d) => d.ackedAt).length };
  };
  return {
    wifi: group("wifi"),
    lora: group("lora"),
    offline: group("offline"),
    summary: {
      total: ds.length,
      acked: ds.filter((d) => d.ackedAt).length,
      accepted: ds.filter((d) => d.response === "accepted").length,
      declined: ds.filter((d) => d.response === "declined").length,
      waiting: ds.filter((d) => !d.ackedAt && !d.skipped && d.viaAtSend !== "offline").length,
      lora: ds.filter((d) => d.viaAtSend === "lora" && !d.skipped).length,
      offline: ds.filter((d) => d.viaAtSend === "offline").length,
      skipped: ds.filter((d) => d.skipped).length,
    },
  };
}

export function messageView(refs: Refs, m: Message, ds: Delivery[], withDevices: boolean) {
  const code = m.icode === undefined ? undefined : refs.instructionCodes.get(m.icode);
  return {
    id: m.id,
    dst: m.dst,
    dst_owner: m.dst === "all" ? null : (refs.owners.get(m.dst) ?? null),
    kind: m.kind,
    source: m.source,
    body: m.body,
    icode: m.icode ?? null,
    pos: m.pos ?? null,
    position: positionRef(refs, m.pos),
    seq: m.seq,
    sent_at: iso(m.sentAt),
    publish_state: m.publishState,
    /** 【案】了解・できない を求めるか(指示コードの一覧の requires_response) */
    requires_response: m.kind === "order" && (code?.requiresResponse ?? true),
    ...deliveryCounts(ds),
    ...(withDevices && {
      devices: ds.map((d) => ({
        id: d.deviceId,
        owner: refs.owners.get(d.deviceId) ?? null,
        via_at_send: d.viaAtSend,
        skipped: d.skipped,
        acked_at: iso(d.ackedAt),
        response: d.response,
        responded_at: iso(d.respondedAt),
      })),
    }),
  };
}
