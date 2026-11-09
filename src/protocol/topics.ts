// MQTT のトピックと端末ID(INTERFACES §1、§3)

export const TOPIC_PREFIX = "reray/v1";
/** サーバーが購読するトピック */
export const UP_ALL = `${TOPIC_PREFIX}/up/#`;

export type UpType = "signal" | "status" | "ack";
const UP_TYPES: readonly string[] = ["signal", "status", "ack"];

export type UpTopic =
  | { kind: "device"; deviceId: string; type: UpType }
  | { kind: "gateway"; gatewayId: string };

/**
 * 上りのトピックを読む。形が違えば null。
 * - `reray/v1/up/{端末ID}/{signal|status|ack}`
 * - `reray/v1/up/gw/{出口ID}/lora`(LoRa のフレームを生のまま。GATEWAY_RAW_FORMAT)
 * 端末ID の形はここでは確かめない(validate で理由を付けて捨てる)。
 */
export function parseUpTopic(topic: string): UpTopic | null {
  const parts = topic.split("/");
  if (parts[0] !== "reray" || parts[1] !== "v1" || parts[2] !== "up") return null;
  if (parts.length === 6 && parts[3] === "gw" && parts[5] === "lora" && parts[4]) {
    return { kind: "gateway", gatewayId: parts[4] };
  }
  if (parts.length === 5 && parts[3] && parts[4] && UP_TYPES.includes(parts[4])) {
    return { kind: "device", deviceId: parts[3], type: parts[4] as UpType };
  }
  return null;
}

/** 「本部に届いた」を返すトピック */
export function downAckTopic(deviceId: string): string {
  return `${TOPIC_PREFIX}/down/${deviceId}/ack`;
}

/** 文字・指示コードを流すトピック。dst は端末ID か "all"(一斉) */
export function downTextTopic(dst: string): string {
  return `${TOPIC_PREFIX}/down/${dst}/text`;
}

// ---- 端末ID ----

/** 端末に割り当てる番号の範囲(0 = サーバー、65535 = 全員 は使わない) */
const MIN_DEVICE_NO = 1;
const MAX_DEVICE_NO = 65534;

/**
 * `dev-001` の番号部分を返す。形が違えば null。
 * 3 桁に満たない番号は 0 で埋めた形だけを認める(`dev-1` や `dev-0001` は不正。同じ端末に 2 つの ID ができないように)。
 */
export function deviceNumber(id: string): number | null {
  const m = /^dev-(\d{3,5})$/.exec(id);
  if (!m?.[1]) return null;
  const no = Number(m[1]);
  if (no < MIN_DEVICE_NO || no > MAX_DEVICE_NO) return null;
  return formatDeviceId(no) === id ? no : null;
}

/** 番号から `dev-001` の形にする(LoRa の 16 ビットの src を直すときにも使う) */
export function formatDeviceId(no: number): string {
  return `dev-${String(no).padStart(3, "0")}`;
}

/** 端末ID の並べ方(番号の順。文字の順だと dev-1000 が dev-999 より前に来るため) */
export function compareDeviceId(a: string, b: string): number {
  return (deviceNumber(a) ?? Number.MAX_SAFE_INTEGER) - (deviceNumber(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b);
}
