// サーバーアプリの入口。MQTT の購読と保存を始める(M1)。
//
// 保存は今はメモリ版(再起動で消える)。MySQL 版ができたら、ここで差し替える(ARCHITECTURE §3.3)。

import { existsSync } from "node:fs";
import { loadConfig } from "./config.js";
import { connectMqtt, publisher } from "./mqtt/connect.js";
import { PcSeq } from "./server/pcSeq.js";
import { Receiver } from "./server/receiver.js";
import { MemoryStorage } from "./storage/memory.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const config = loadConfig();
const storage = new MemoryStorage();
const pcSeq = await PcSeq.fromStorage(storage);

// Receiver と MQTT のクライアントはお互いを使うので、publish は後からつなぐ
let publish: (topic: string, payload: string) => Promise<void> = async () => {
  throw new Error("MQTT にまだつながっていない");
};
const receiver = new Receiver({ storage, pcSeq, publish: (t, p) => publish(t, p) });
const client = connectMqtt(config, (topic, payload) => receiver.handle(topic, payload));
publish = publisher(client);

console.log("Re-Ray_Server: 起動しました(保存はメモリ版)");

async function shutdown(): Promise<void> {
  console.log("Re-Ray_Server: 止めます");
  await receiver.drain();
  await client.endAsync();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
