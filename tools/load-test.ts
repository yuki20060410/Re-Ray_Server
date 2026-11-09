// 負荷の試験: 「疑似 100 件が欠け・重複なく記録される。壊れたデータを送っても止まらない」を確かめる
//
// 使い方: サーバーを起動したまま(npm run dev)、別のターミナルで
//   npm run load-test            偽の端末 100 台
//   npm run load-test -- 200     台数を変える
//
// 1. 偽の端末を N 台(dev-1001〜)つなぐ
// 2. 全台が同時に定型信号を 1 通ずつ送る
// 3. 全台が同じ seq でもう 1 回送る(重複。記録されてはいけない)
// 4. 壊れたデータ(JSON でない、版が違う、範囲外の番号、形の違う端末ID、無い mid の ack)を混ぜる
// 5. 「本部に届いた」の返事の数と、API(/api/logs)で見える記録の数を数える
//
// 試験用の端末(dev-1001〜)は記録に残る(API に消す口は作らない)。消すときは DB を空にする(README §6.1)。
// 2026-11-06: reray-app/server/scripts/load-test.js を TypeScript に直して取り込んだ(数えるのは DB ではなく API で)

import { existsSync } from "node:fs";
import mqtt from "mqtt";
import { FakeDevice } from "../src/dev/fakeFleet.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const MQTT_URL = process.env.MQTT_URL || "mqtt://localhost:1883";
const API = process.env.API_URL || `http://localhost:${process.env.HTTP_PORT || 3000}/api`;
const N = Number(process.argv[2]) || 100;
const FIRST = 1001;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T>(path: string): Promise<T> {
  const res = await fetch(API + path);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const startedAt = new Date();
await api("/health"); // サーバーが動いていなければ、ここで止まる

console.log(`1. 偽の端末を ${N} 台つなぎます(${MQTT_URL})`);
const devs = await Promise.all(
  Array.from({ length: N }, (_, i) => new FakeDevice({ url: MQTT_URL, id: `dev-${FIRST + i}`, glass: false }).connect()),
);
await sleep(1500); // status が届くのを待つ

console.log("2. 全台が同時に定型信号を送ります");
const sent = devs.map((d, i) => ({ d, code: 2 + (i % 8), seq: 0 }));
for (const s of sent) s.seq = s.d.sendSignal(s.code);

console.log("3. 同じ seq でもう 1 回送ります(重複)");
await sleep(200);
for (const s of sent) s.d.resendSignal(s.seq, s.code);

console.log("4. 壊れたデータを混ぜます");
const bad = await mqtt.connectAsync(MQTT_URL, { clientId: "load-test-bad", protocolVersion: 4 });
const t = (kind: string) => `reray/v1/up/dev-${FIRST}/${kind}`;
const src = `dev-${FIRST}`;
await bad.publishAsync(t("signal"), "{これはJSONではない", { qos: 1 });
await bad.publishAsync(t("signal"), JSON.stringify({ v: 9, type: "signal", src, seq: 1, code: 2 }), { qos: 1 });
await bad.publishAsync(t("signal"), JSON.stringify({ v: 1, type: "signal", src, seq: 2, code: 99 }), { qos: 1 });
await bad.publishAsync(t("signal"), JSON.stringify({ v: 1, type: "signal", src: "dev-9999", seq: 3, code: 2 }), { qos: 1 });
await bad.publishAsync("reray/v1/up/xyz/signal", "abc", { qos: 1 });
await bad.publishAsync(t("ack"), JSON.stringify({ v: 1, type: "ack", src, seq: 4, ts: 1, ack_mid: 999999 }), { qos: 1 });

console.log("5. 返事と記録を数えます(最大 20 秒待ちます)");
let acked = 0;
for (let i = 0; i < 40; i++) {
  acked = sent.filter((s) => s.d.hqAcked.get(s.seq) === true).length;
  if (acked === N) break;
  await sleep(500);
}
const ids = new Set(devs.map((d) => d.id));
const logs = await api<{ type: string; signal?: { device: string; seq: number } }[]>(
  `/logs?type=signal&limit=500&from=${encodeURIComponent(startedAt.toISOString())}`,
);
const mine = logs.filter((x) => x.signal && ids.has(x.signal.device));
const uniq = new Set(mine.map((x) => `${x.signal?.device}/${x.signal?.seq}`)).size;
const health = await api<{ ok: boolean; mqtt: boolean }>("/health");

console.log("");
console.log(`   送った端末          : ${N} 台(1 台 2 通。2 通目は重複)`);
console.log(`   本部に届いた(返事)  : ${acked} / ${N}`);
console.log(`   記録された signal   : ${mine.length}(重複なしの組: ${uniq})`);
console.log(`   サーバー            : ${health.ok && health.mqtt ? "動いている" : "止まった・切れた"}`);
const ok = acked === N && mine.length === N && uniq === N && health.ok && health.mqtt;
console.log(`   結果                : ${ok ? "合格(欠けなし・重複なし・壊れたデータでも止まらない)" : "不合格"}`);
if (N > 500) console.log("   (注意)記録は 500 件までしか数えない");

for (const d of devs) await d.close();
await bad.endAsync();
// process.exit() で抜けると、Windows では閉じかけの通信路で Node が落ちる(UV_HANDLE_CLOSING)ので、自然に終わらせる
process.exitCode = ok ? 0 : 1;
