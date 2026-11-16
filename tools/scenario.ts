// 本番に近い流れのシナリオ(実機なしで、管理画面が MQTT の受信にどう反応するかを確かめる)
//
// 使い方(サーバーを npm run dev で起動したまま、別のターミナルで):
//   npx tsx tools/scenario.ts               端末 5 台(+登録していない 1 台)がつながり、下の流れを順に送る。終わっても待ち受けを続ける
//   npx tsx tools/scenario.ts --fast        間隔を 1/5 にする(16 の「時間切れ」は短くならない。約 1 分 40 秒待つ)
//   npx tsx tools/scenario.ts --register    始める前に 5 台を API で「端末の登録」する(個別送信を試すため。2 回目からは「登録済み」と出るだけ)
//   npx tsx tools/scenario.ts --skip-timeout  16 の「時間切れ」を飛ばす
//
// 各段のあとに「画面で見るところ」を表示し、サーバーの API で結果を確かめて ✅ / ❌ を出す(最後に合計)。
//
//   1. 5 台がつながって状態を送る(電池・グラス・経路・位置)
//   2. 平時の定型信号(到着・了解)
//   3. 数量つき・方角つきの信号(要救助者 10 人、移動します 北東)
//   4. dev-004 が LoRa に切り替わり、LoRa 経由で信号
//   5. 同じ seq をもう一度(重複。記録が増えないこと)
//   6. 形の崩れたもの 3 種(捨てられ、画面は変わらないこと)
//   7. dev-005 の電池が 12% に
//   8. dev-001 が SOS(赤い帯と音)
//   9. dev-002 が黙って切れる(遺言ですぐ「切れた」)
//  10. 切れている間に、本部が全員に指示を送る(API。dev-002 は「切れている」に数えられる)
//  11. dev-002 がつなぎ直す(「つながっている」に戻り、切れている間の指示が後から届いて返事をする)
//  12. 登録していない端末 dev-006 から状態と信号が届く
//  13. 遅れて届く信号(端末の時刻が 10 分前)と、時計が合っていない信号(ts = 0)
//  14. 範囲外の数量(200 人)と方角(12)。捨てずに保存し、印を付けること
//  15. seq の一周(65535 の次が 0)。どちらも記録されること
//  16. LoRa の出口から生のフレームが届く(今のサーバーは 16 進で残すだけ。画面が変わらないこと)
//  17. dev-006 が遺言なしで黙る → Wi-Fi は 90 秒で「切れた」(時間切れの判定)
//  18. 以後は待ち受け:30 秒ごとに状態を送り、届いた文字・指示に返事をする
//      (Wi-Fi は約 1 秒で「届いた」、グラスのある端末は 3 秒後に「了解」。dev-005 は「できない」。LoRa の dev-004 は自由な文に返事をしない)
//
// まだ入っていないもの: LoRa の端末の 15 分の時間切れ、LoRa のフレームの中身の分解(サーバーが未対応)、実機ならではの癖
//
// 2026-11-13 追加(フロントエンドの検証用。偽の端末と同じ ID なので DEV_TOOLS=0 で使う)
// 2026-11-13 10〜17 と、API での自動の確かめを足した

import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import mqtt, { type MqttClient } from "mqtt";

if (existsSync(".env")) process.loadEnvFile(".env");
const URL = process.env.MQTT_URL || "mqtt://localhost:1883";
const API = `http://localhost:${process.env.HTTP_PORT || 3000}`;

const { values } = parseArgs({
  options: {
    fast: { type: "boolean", default: false },
    register: { type: "boolean", default: false },
    "skip-timeout": { type: "boolean", default: false },
  },
});
const SPEED = values.fast ? 0.2 : 1;
const sleep = (sec: number) => new Promise((r) => setTimeout(r, sec * 1000 * SPEED));
const realSleep = (sec: number) => new Promise((r) => setTimeout(r, sec * 1000));
const now = () => Math.floor(Date.now() / 1000);

interface Device {
  id: string;
  owner: string;
  battery: number;
  glass: boolean;
  via: "wifi" | "lora";
  pos: number;
  lat: number;
  lon: number;
  /** 文字・指示への返事(4 = 了解、5 = できない)。glass が無ければ「届いた」だけ */
  reply: 4 | 5;
  /** 遺言を登録するか(17 の時間切れを試す端末は登録しない) */
  will: boolean;
  /** API で登録するか(12 の「登録していない端末」は登録しない) */
  register: boolean;
  seq: number;
  client?: MqttClient;
  timer?: NodeJS.Timeout;
}

// 位置はポジション表(db/init/02)の近く
const devices: Device[] = [
  { id: "dev-001", owner: "本部 田中", battery: 92, glass: true,  via: "wifi", pos: 1, lat: 35.68121, lon: 139.76712, reply: 4, will: true, register: true, seq: 0 },
  { id: "dev-002", owner: "北口 佐藤", battery: 78, glass: true,  via: "wifi", pos: 2, lat: 35.68231, lon: 139.76679, reply: 4, will: true, register: true, seq: 0 },
  { id: "dev-003", owner: "体育館 鈴木", battery: 64, glass: true, via: "wifi", pos: 3, lat: 35.67992, lon: 139.76852, reply: 4, will: true, register: true, seq: 0 },
  { id: "dev-004", owner: "南橋 高橋", battery: 55, glass: false, via: "wifi", pos: 4, lat: 35.67871, lon: 139.76618, reply: 4, will: true, register: true, seq: 0 },
  { id: "dev-005", owner: "巡回 伊藤", battery: 30, glass: true,  via: "wifi", pos: 0, lat: 35.68050, lon: 139.76700, reply: 5, will: true, register: true, seq: 0 },
  { id: "dev-006", owner: "",          battery: 88, glass: false, via: "wifi", pos: 2, lat: 35.68240, lon: 139.76690, reply: 4, will: false, register: false, seq: 0 },
];
const byId = (id: string) => devices.find((d) => d.id === id)!;

// ---- 表示と確かめ ----

let passed = 0;
const failed: string[] = [];

function step(no: number, title: string, look: string): void {
  console.log(`\n━━ ${no}. ${title}`);
  console.log(`   画面で見る: ${look}`);
}

/** 条件が成り立つまで最大 timeout 秒待って、✅ / ❌ を出す */
async function check(label: string, cond: () => Promise<boolean>, timeout = 6): Promise<void> {
  const until = Date.now() + timeout * 1000;
  let ok = false;
  while (true) {
    try {
      ok = await cond();
    } catch {
      ok = false;
    }
    if (ok || Date.now() >= until) break;
    await realSleep(0.3);
  }
  console.log(`   ${ok ? "✅" : "❌"} ${label}`);
  if (ok) passed++;
  else failed.push(label);
}

// ---- サーバーの API(確かめる用) ----

interface DeviceView {
  id: string;
  registered: boolean;
  online: boolean;
  via: string | null;
  battery: number | null;
  open_sos?: unknown[];
}
interface SignalView {
  id: number;
  seq: number;
  code: number;
  n: number | null;
  dir: number | null;
  via: string | null;
  out_of_range: boolean;
  at: string;
  device_ts: string | null;
}
interface MessageView {
  summary: { total: number; acked: number; offline: number };
  devices: { id: string; via_at_send: string; acked_at: string | null }[];
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(API + path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}
const deviceView = async (id: string) => (await getJson<DeviceView[]>("/api/devices")).find((d) => d.id === id);
const signalsOf = async (id: string) =>
  (await getJson<{ signal?: SignalView }[]>(`/api/logs?type=signal&device=${id}&limit=500`)).flatMap((i) => (i.signal ? [i.signal] : []));
const signalBySeq = async (id: string, seq: number) => (await signalsOf(id)).find((s) => s.seq === seq);

// ---- 端末の動き ----

async function pub(d: Device, type: "signal" | "status" | "ack", body: Record<string, unknown>, opts: { seq?: number; ts?: number } = {}): Promise<number> {
  const s = opts.seq ?? (d.seq = (d.seq + 1) & 0xffff);
  const payload = { v: 1, type, src: d.id, seq: s, ts: opts.ts ?? now(), ...body };
  await d.client!.publishAsync(`reray/v1/up/${d.id}/${type}`, JSON.stringify(payload), { qos: 1 });
  const note = [opts.seq !== undefined && `seq ${s}`, opts.ts !== undefined && `ts ${opts.ts}`].filter(Boolean).join(" ");
  console.log(`   → ${d.id} ${type} ${JSON.stringify(body)}${note ? ` (${note})` : ""}`);
  return s;
}

const status = (d: Device) => pub(d, "status", { battery: d.battery, glass: d.glass, via: d.via, lat: d.lat, lon: d.lon });
const signal = (d: Device, code: number, extra: Record<string, unknown> = {}, opts: { seq?: number; ts?: number } = {}) =>
  pub(d, "signal", { code, pos: d.pos, via: d.via, ...extra }, opts);

function onDown(d: Device, topic: string, raw: Buffer): void {
  let body: { type?: string; mid?: number; ack_seq?: number; body?: string; icode?: number };
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return;
  }
  if (body.type === "ack") {
    console.log(`   ← ${d.id} 本部に届いた (seq ${body.ack_seq})`);
    return;
  }
  if (body.type !== "text" || typeof body.mid !== "number") return;
  const mid = body.mid;
  const isInstruction = body.icode !== undefined;
  console.log(`   ← ${d.id} ${isInstruction ? `指示 ${body.icode}` : "文字"} mid=${mid} ${body.body ?? ""} (${topic})`);
  // LoRa 中は自由な文を受け取れない(出口が LoRa に運ぶのは指示コードだけ)
  if (d.via === "lora" && !isInstruction) return;
  const delay = d.via === "lora" ? 5 : 1;
  setTimeout(() => d.client && void pub(d, "ack", { ack_mid: mid, ack_kind: 3 }), delay * 1000);
  if (d.glass) setTimeout(() => d.client && void pub(d, "ack", { ack_mid: mid, ack_kind: d.reply }), (delay + 3) * 1000);
}

async function connect(d: Device, freshSeq = true): Promise<void> {
  // 端末と同じく、起動のたびに seq を乱数から始める
  if (freshSeq) d.seq = Math.floor(Math.random() * 65536);
  const client = mqtt.connect(URL, {
    clientId: d.id,
    clean: false,
    protocolVersion: 4,
    keepalive: 30,
    reconnectPeriod: 0,
    ...(d.will && {
      will: {
        topic: `reray/v1/up/${d.id}/status`,
        payload: Buffer.from(JSON.stringify({ v: 1, type: "status", src: d.id, online: false })),
        qos: 1 as const,
        retain: false,
      },
    }),
    ...(process.env.MQTT_USER && { username: process.env.MQTT_USER }),
    ...(process.env.MQTT_PASS && { password: process.env.MQTT_PASS }),
  });
  // 切れている間に溜まった下りは、つないだ直後に届くので、つなぐ前に付けておく
  client.on("message", (t, p) => onDown(d, t, p));
  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve());
    client.once("error", reject);
  });
  await client.subscribeAsync([`reray/v1/down/${d.id}/#`, "reray/v1/down/all/#"], { qos: 1 });
  d.client = client;
  d.timer = setInterval(() => void status(d), 30_000);
}

/** 正しく切断すると遺言が流れないので、通信路を壊す */
function dropSilently(d: Device): void {
  clearInterval(d.timer);
  const c = d.client!;
  d.client = undefined;
  c.stream.destroy();
  c.end(true);
}

async function register(): Promise<void> {
  for (const d of devices.filter((x) => x.register)) {
    const res = await fetch(`${API}/api/devices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: d.id, owner: d.owner }),
    });
    console.log(`   登録 ${d.id}: ${res.ok ? "OK" : `${res.status} ${await res.text()}`}`);
  }
}

// ---- 流れ ----

async function main(): Promise<void> {
  console.log(`ブローカー ${URL} / 管理画面 ${API}${values.fast ? "(速め)" : ""}`);
  await getJson("/api/health").catch(() => {
    throw new Error(`サーバー(${API})につながりません。先に npm run dev で起動してください`);
  });

  if (values.register) {
    console.log("\n━━ 0. 端末の登録(API)");
    await register();
  }

  const five = devices.filter((d) => d.id !== "dev-006");

  step(1, "5 台がつながる", "端末一覧に 5 台、つながりの緑の点、電池・グラス・経路");
  for (const d of five) await connect(d);
  for (const d of five) await status(d);
  await check("5 台とも「つながっている」", async () => {
    const list = await getJson<DeviceView[]>("/api/devices");
    return five.every((d) => list.find((v) => v.id === d.id)?.online === true);
  });
  await sleep(5);

  step(2, "平時の定型信号", "端末一覧の「最後の連絡」、記録の画面に 2 行");
  const s2a = await signal(byId("dev-002"), 4); // 到着
  await sleep(2);
  const s2b = await signal(byId("dev-003"), 3); // 了解
  await check("到着・了解が記録された", async () => !!(await signalBySeq("dev-002", s2a)) && !!(await signalBySeq("dev-003", s2b)));
  await sleep(5);

  step(3, "数量つき・方角つき", "「要救助者あり 10人」「移動します 北東」の出方");
  const s3a = await signal(byId("dev-003"), 6, { n: 10 });
  await sleep(2);
  const s3b = await signal(byId("dev-005"), 9, { dir: 2 });
  await check("n = 10 と dir = 2 が入った", async () => (await signalBySeq("dev-003", s3a))?.n === 10 && (await signalBySeq("dev-005", s3b))?.dir === 2);
  await sleep(5);

  step(4, "dev-004 が LoRa に切り替わる", "dev-004 の経路が LoRa、信号の経路も LoRa");
  const d4 = byId("dev-004");
  d4.via = "lora";
  await status(d4);
  await sleep(2);
  const s4 = await signal(d4, 7, { n: 5 }); // 負傷者 5 人
  await check("dev-004 の経路が LoRa", async () => (await deviceView("dev-004"))?.via === "lora" && (await signalBySeq("dev-004", s4))?.via === "lora");
  await sleep(5);

  step(5, "同じ seq の再送(重複)", "記録が増えないこと(dev-003 の要救助者が 1 行のまま)");
  const d3 = byId("dev-003");
  const before5 = (await signalsOf("dev-003")).length;
  await signal(d3, 6, { n: 10 }, { seq: s3a });
  await realSleep(1.5);
  await check("dev-003 の記録が増えていない", async () => (await signalsOf("dev-003")).length === before5, 1);
  await sleep(5);

  step(6, "形の崩れたもの 3 種", "画面は何も変わらないこと(サーバーのターミナルに捨てた理由)");
  const before6 = (await signalsOf("dev-001")).length;
  const c1 = byId("dev-001").client!;
  await c1.publishAsync("reray/v1/up/dev-001/signal", "{", { qos: 1 });
  await c1.publishAsync("reray/v1/up/dev-001/signal", JSON.stringify({ v: 1, type: "signal", src: "dev-999", seq: 1, code: 2 }), { qos: 1 });
  await c1.publishAsync("reray/v1/up/dev-001/signal", JSON.stringify({ v: 1, type: "signal", src: "dev-001", seq: 2, code: 99 }), { qos: 1 });
  console.log("   → 壊れた JSON / src の食い違い / code が範囲外");
  await realSleep(1.5);
  await check("どれも記録されていない", async () => (await signalsOf("dev-001")).length === before6 && !(await deviceView("dev-999")), 1);
  await sleep(5);

  step(7, "dev-005 の電池が減る", "dev-005 の電池 12%(少ない印が出るか)");
  const d5 = byId("dev-005");
  d5.battery = 12;
  await status(d5);
  await check("dev-005 の電池が 12%", async () => (await deviceView("dev-005"))?.battery === 12);
  await sleep(5);

  step(8, "dev-001 が SOS", "全画面の赤い帯・音・題名の点滅。帯の「対応済みにする」");
  const s8 = await signal(byId("dev-001"), 1);
  await check("未対応の SOS に入った", async () => {
    const sos = await getJson<{ device: string; seq: number }[]>("/api/sos");
    return sos.some((s) => s.device === "dev-001" && s.seq === s8);
  });
  await sleep(8);

  step(9, "dev-002 が黙って切れる", "dev-002 が「切れた」になる(遺言なのですぐ)");
  dropSilently(byId("dev-002"));
  await check("dev-002 が「切れた」", async () => (await deviceView("dev-002"))?.online === false);
  await sleep(4);

  step(10, "切れている間に本部が全員に指示(API から送る)", "一斉送信の「最近送ったもの」で、dev-002 が「切れている」に数えられる");
  const res10 = await fetch(`${API}/api/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dst: "all", kind: "order", icode: 3, pos: 0 }), // その場で待機してください
  });
  const mid10 = ((await res10.json()) as { id: number }).id;
  console.log(`   → 本部 全員に指示 3(その場で待機)mid=${mid10}`);
  await check("dev-002 は送った時点で「切れている」", async () => {
    const m = await getJson<MessageView>(`/api/messages/${mid10}`);
    return m.devices.find((x) => x.id === "dev-002")?.via_at_send === "offline";
  });
  await sleep(5);

  step(11, "dev-002 がつなぎ直す", "dev-002 が「つながっている」に戻る。さっきの指示の「届いた数」が 1 つ増える");
  const d2 = byId("dev-002");
  await connect(d2);
  await status(d2);
  await check("dev-002 が「つながっている」に戻った", async () => (await deviceView("dev-002"))?.online === true);
  await check("切れている間の指示が後から届いた(dev-002 の届いた)", async () => {
    const m = await getJson<MessageView>(`/api/messages/${mid10}`);
    return !!m.devices.find((x) => x.id === "dev-002")?.acked_at;
  }, 8);
  await sleep(5);

  step(12, "登録していない端末 dev-006 から届く", "端末一覧に dev-006 が出るか(名前なし・未登録の出方)");
  const d6 = byId("dev-006");
  await connect(d6);
  await status(d6);
  await sleep(1);
  await signal(d6, 2); // 無事
  await check("dev-006 が「未登録」で一覧に入った", async () => {
    const v = await deviceView("dev-006");
    return !!v && v.registered === false && v.online === true;
  });
  await sleep(5);

  step(13, "遅れて届く信号・時計が合っていない信号", "記録の画面で、受けた時刻と端末の時刻の出方(10 分前の信号が上に来ないか)");
  const s13a = await signal(d3, 4, {}, { ts: now() - 600 }); // 10 分前に押した到着
  const s13b = await signal(d3, 2, {}, { ts: 0 }); // 時計が合っていない
  await check("10 分前の端末の時刻が残っている", async () => {
    const s = await signalBySeq("dev-003", s13a);
    return !!s?.device_ts && Date.parse(s.at) - Date.parse(s.device_ts) > 590_000;
  });
  await check("ts = 0 は端末の時刻なしとして保存", async () => {
    const s = await signalBySeq("dev-003", s13b);
    return !!s && s.device_ts === null;
  });
  await sleep(5);

  step(14, "範囲外の数量・方角", "「200人」「方角 12」に範囲外の印が付くか");
  const s14a = await signal(d3, 6, { n: 200 });
  const s14b = await signal(d5, 9, { dir: 12 });
  await check("n = 200 は保存されて範囲外の印", async () => (await signalBySeq("dev-003", s14a))?.out_of_range === true);
  await check("dir = 12 は保存されて範囲外の印", async () => (await signalBySeq("dev-005", s14b))?.out_of_range === true);
  await sleep(5);

  step(15, "seq の一周(65535 → 0)", "dev-005 の記録に 2 行増える");
  const before15 = (await signalsOf("dev-005")).length;
  await signal(d5, 4, {}, { seq: 65535 });
  await signal(d5, 3, {}, { seq: 0 });
  d5.seq = 0;
  await check("65535 と 0 の両方が記録された", async () => (await signalsOf("dev-005")).length === before15 + 2);
  await sleep(5);

  step(16, "LoRa の出口から生のフレーム", "画面は何も変わらないこと(今のサーバーは 16 進で残すだけで、中身は分解しない)");
  const countBefore16 = (await getJson<DeviceView[]>("/api/devices")).length;
  await byId("dev-001").client!.publishAsync("reray/v1/up/gw/dev-001/lora", Buffer.from([0x11, 0x00, 0x05, 0x2a, 0x06, 0x03, 0x14, 0xde, 0xad, 0xbe, 0xef]), { qos: 1 });
  console.log("   → dev-001(出口)lora 11 bytes");
  await realSleep(1.5);
  await check("サーバーが止まらず、端末の数も変わらない", async () => (await getJson<DeviceView[]>("/api/devices")).length === countBefore16, 1);

  if (values["skip-timeout"]) {
    console.log("\n━━ 17. 時間切れ(--skip-timeout で飛ばした)");
  } else {
    step(17, "dev-006 が遺言なしで黙る(時間切れ)", "約 90〜100 秒後に dev-006 が「切れた」になる。それまでは「つながっている」のまま");
    dropSilently(d6); // 遺言を登録していないので、ブローカーは何も流さない
    const t0 = Date.now();
    await realSleep(60);
    await check("60 秒ではまだ「つながっている」", async () => (await deviceView("dev-006"))?.online === true, 1);
    await check("90 秒+判定の間隔のうちに「切れた」", async () => (await deviceView("dev-006"))?.online === false, 50);
    console.log(`   (黙ってから ${Math.round((Date.now() - t0) / 1000)} 秒)`);
  }

  console.log(`\n━━ 結果: ✅ ${passed} / ❌ ${failed.length}`);
  for (const f of failed) console.log(`   ❌ ${f}`);

  console.log("\n━━ 18. 待ち受け中(Ctrl+C で止める)");
  console.log("   画面で試す: 一斉送信で指示・文字を送る → 「N台中M台に届いた」、了解/できない の数");
  console.log("   dev-004(LoRa)は指示だけ届き、自由な文は別に数えられる。dev-006 は切れている");
}

await main();
