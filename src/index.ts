// サーバーアプリの入口
//
// 1. 保存の窓口を選ぶ(STORAGE=memory / mysql)
// 2. MQTT の購読と受信(Receiver)、送信(Sender)、「切れた」の判定(Presence)を始める
// 3. HTTP API と管理画面(web/)を配る(http://localhost:3000)
// 4. DEV_TOOLS=1 なら、偽の端末をつなぎ、管理画面の「テスト用」の欄を使えるようにする
// 2026-11-06: M2・M3(HTTP API、送信、切れた判定)と MySQL 版を足した(reray-app から取り込み)
// 2026-11-24: チャンネル(ChannelService)と音声(VoiceService)を足した

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { FakeFleet } from "./dev/fakeFleet.js";
import { buildApp } from "./http/app.js";
import { connectMqtt, publisher, retainedPublisher, strictPublisher } from "./mqtt/connect.js";
import { ChannelService } from "./server/channels.js";
import { PcSeq } from "./server/pcSeq.js";
import { Presence } from "./server/presence.js";
import { Receiver } from "./server/receiver.js";
import { Sender } from "./server/sender.js";
import { MemoryStorage } from "./storage/memory.js";
import { MysqlStorage } from "./storage/mysql.js";
import type { Storage } from "./storage/types.js";
import { VoiceService } from "./voice/service.js";
import { OpenAiCompatibleTranscriber, PlaceholderTranscriber } from "./voice/transcriber.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const config = loadConfig();

let storage: Storage;
if (config.storage === "mysql") {
  const mysqlStorage = MysqlStorage.create(config.db);
  await mysqlStorage.ping(); // つながらなければ、ここで止まる(理由はエラーに出る)
  storage = mysqlStorage;
} else {
  storage = new MemoryStorage();
}
const pcSeq = await PcSeq.fromStorage(storage);

// Receiver と MQTT のクライアントはお互いを使うので、publish は後からつなぐ
let publish: (topic: string, payload: string) => Promise<void> = async () => {
  throw new Error("MQTT にまだつながっていない");
};
const receiver = new Receiver({ storage, pcSeq, publish: (t, p) => publish(t, p), loraKey: config.loraKey });
if (!config.loraKey) {
  console.warn("RERAY_HMAC_KEY が無いので、出口から届く LoRa のフレームは署名を確かめられず、すべて捨てます");
}
const client = connectMqtt(config, (topic, payload) => receiver.handle(topic, payload));
publish = publisher(client);

// 【案】チャンネル(2026-11-24)。ブローカーにつながるたびに、登録した全端末へ設定を配り直す
const channels = new ChannelService({ storage, pcSeq, publishRetained: retainedPublisher(client) });
client.on("connect", () => {
  channels.publishAll().catch((err: unknown) => console.error("設定を配り直せなかった", err));
});

const sender = new Sender({ storage, pcSeq, publish: strictPublisher(client), channels });

// 【案】音声(2026-11-24)。STT_URL が無ければ仮の文字起こし
const transcriber = config.stt.url
  ? new OpenAiCompatibleTranscriber({
      baseUrl: config.stt.url,
      model: config.stt.model,
      language: config.stt.language,
      ...(config.stt.apiKey && { apiKey: config.stt.apiKey }),
    })
  : new PlaceholderTranscriber();
const voice = new VoiceService({ storage, sender, transcriber, dir: config.voiceDir });
await voice.start();
const presence = new Presence({ storage });
presence.start();

const fleet = config.devTools ? new FakeFleet(config.mqttUrl, storage, receiver) : null;

const webDir = fileURLToPath(new URL("../web/", import.meta.url));
const app = await buildApp({
  storage,
  sender,
  isMqttConnected: () => client.connected,
  storageKind: config.storage,
  webDir,
  dev: fleet,
  channels,
  voice,
});
await app.listen({ port: config.httpPort, host: "0.0.0.0" });

console.log(
  `Re-Ray_Server: 起動しました(保存: ${config.storage === "mysql" ? "MySQL" : "メモリ版"}、` +
    `画面と API: http://localhost:${config.httpPort}、文字起こし: ${voice.transcriberLabel})`,
);

if (fleet) {
  // ブローカーにつながってから偽の端末をつなぐ
  client.once("connect", () => {
    fleet
      .start(config.devFakes)
      .then((ids) => console.log(`偽の端末を動かしています: ${ids.join(", ") || "なし"}(DEV_TOOLS=1)`))
      .catch((err: unknown) => console.error("偽の端末をつなげなかった", err));
  });
}

async function shutdown(): Promise<void> {
  console.log("Re-Ray_Server: 止めます");
  presence.stop();
  await fleet?.stopAll();
  await app.close();
  await voice.stop();
  await receiver.drain();
  await client.endAsync();
  await storage.close();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
