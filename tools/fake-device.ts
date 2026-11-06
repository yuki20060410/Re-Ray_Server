// 疑似端末ツール(実機なしで、端末の代わりに MQTT に流す。ARCHITECTURE §3.4)
//
// 使い方(Git Bash / PowerShell どちらでも):
//   npm run fake -- signal --id dev-001 --code 6 --pos 3 --n 20     定型信号を 1 件送り、「本部に届いた」を待つ
//   npm run fake -- signal --id dev-001 --count 5                    seq を 1 つずつ進めて 5 件
//   npm run fake -- signal --id dev-001 --seq 42 --repeat 3          同じ seq を 3 回(重複の確かめ)
//   npm run fake -- signal --id dev-001 --via lora                   LoRa から届いた扱い(via だけ変わる)
//   npm run fake -- status --id dev-001 --battery 80 --glass true    状態を送る
//   npm run fake -- will   --id dev-001                              遺言を登録してから、黙って切れる
//   npm run fake -- raw    --topic reray/v1/up/dev-001/signal --payload "{"   形の崩れたものを送る
//   npm run fake -- listen --id dev-001                              下り(text・本部に届いた)を表示し続ける
//
// 端末と同じく、クライアントID = 端末ID、永続セッション、keepalive 30 秒でつなぐ(DATAFLOW §8.3)。
// seq を指定しなければ、端末と同じく乱数から始める(修正案 #3)。

import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import mqtt, { type MqttClient } from "mqtt";

if (existsSync(".env")) process.loadEnvFile(".env");
const URL = process.env.MQTT_URL || "mqtt://localhost:1883";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    id: { type: "string", default: "dev-001" },
    seq: { type: "string" },
    code: { type: "string", default: "6" },
    pos: { type: "string", default: "3" },
    n: { type: "string" },
    dir: { type: "string" },
    via: { type: "string", default: "wifi" },
    count: { type: "string", default: "1" },
    repeat: { type: "string", default: "1" },
    battery: { type: "string" },
    glass: { type: "string" },
    topic: { type: "string" },
    payload: { type: "string" },
    wait: { type: "string", default: "5" },
  },
});

const command = positionals[0];
const id = values.id;
const now = () => Math.floor(Date.now() / 1000);
const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));

/** 下りを受けたときの処理。つないだ直後に溜まっていた分が届くので、つなぐ前に付けておく */
const acked = new Set<number>();

function onDown(topic: string, payload: Buffer): void {
  const text = payload.toString("utf8");
  console.log(`← ${topic} ${text}`);
  try {
    const body = JSON.parse(text) as { type?: string; ack_seq?: number };
    if (body.type === "ack" && typeof body.ack_seq === "number") acked.add(body.ack_seq);
  } catch {
    // 表示だけ
  }
}

function connect(opts: mqtt.IClientOptions = {}): Promise<MqttClient> {
  const client = mqtt.connect(URL, {
    clientId: id,
    clean: false,
    protocolVersion: 4,
    keepalive: 30,
    ...(process.env.MQTT_USER && { username: process.env.MQTT_USER }),
    ...(process.env.MQTT_PASS && { password: process.env.MQTT_PASS }),
    ...opts,
  });
  client.on("message", onDown);
  return new Promise((resolve, reject) => {
    client.once("connect", () => resolve(client));
    client.once("error", reject);
  });
}

async function publish(client: MqttClient, topic: string, body: unknown): Promise<void> {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  await client.publishAsync(topic, payload, { qos: 1, retain: false });
  console.log(`→ ${topic} ${payload}`);
}

/** 下りを購読する(表示は onDown)。永続セッションなので、次につないだときも届く */
async function listenDown(client: MqttClient): Promise<void> {
  await client.subscribeAsync([`reray/v1/down/${id}/#`, "reray/v1/down/all/#"], { qos: 1 });
}

async function waitFor(done: () => boolean, sec: number): Promise<boolean> {
  const until = Date.now() + sec * 1000;
  while (!done() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  return done();
}

async function main(): Promise<void> {
  switch (command) {
    case "signal": {
      const client = await connect();
      await listenDown(client);

      let seq = num(values.seq) ?? Math.floor(Math.random() * 65536);
      const sent: number[] = [];
      for (let i = 0; i < Number(values.count); i++) {
        for (let r = 0; r < Number(values.repeat); r++) {
          await publish(client, `reray/v1/up/${id}/signal`, {
            v: 1, type: "signal", src: id, seq, ts: now(),
            code: Number(values.code), pos: Number(values.pos),
            ...(values.n !== undefined && { n: Number(values.n) }),
            ...(values.dir !== undefined && { dir: Number(values.dir) }),
            via: values.via,
          });
        }
        sent.push(seq);
        seq = (seq + 1) & 0xffff;
      }

      const ok = await waitFor(() => sent.every((s) => acked.has(s)), Number(values.wait));
      const missing = sent.filter((s) => !acked.has(s));
      console.log(ok ? `本部に届いた: ${sent.length} 件すべて` : `本部に届いたが来ない seq: ${missing.join(", ")}`);
      await client.endAsync();
      process.exitCode = ok ? 0 : 1;
      break;
    }
    case "status": {
      const client = await connect();
      await publish(client, `reray/v1/up/${id}/status`, {
        v: 1, type: "status", src: id, seq: num(values.seq) ?? Math.floor(Math.random() * 65536), ts: now(),
        ...(values.battery !== undefined && { battery: Number(values.battery) }),
        ...(values.glass !== undefined && { glass: values.glass === "true" }),
      });
      await client.endAsync();
      break;
    }
    case "will": {
      const client = await connect({
        will: {
          topic: `reray/v1/up/${id}/status`,
          payload: Buffer.from(JSON.stringify({ v: 1, type: "status", src: id, online: false })),
          qos: 1,
          retain: false,
        },
      });
      console.log("遺言を登録した。黙って切れます(ブローカーが遺言を流す)");
      // 正しく切断(DISCONNECT)すると遺言は流れないので、通信路をそのまま壊す
      client.stream.destroy();
      client.end(true);
      break;
    }
    case "raw": {
      if (!values.topic || values.payload === undefined) throw new Error("--topic と --payload が要ります");
      const client = await connect();
      await publish(client, values.topic, values.payload);
      await client.endAsync();
      break;
    }
    case "listen": {
      const client = await connect();
      await listenDown(client);
      console.log(`下りを待っています(${id})。Ctrl+C で止める`);
      break;
    }
    default:
      console.log("使い方は tools/fake-device.ts の先頭を見てください(signal / status / will / raw / listen)");
      process.exitCode = 2;
  }
}

await main();
