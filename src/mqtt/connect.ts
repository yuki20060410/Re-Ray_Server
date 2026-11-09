// ブローカーにつなぎ、上りを購読する(DATAFLOW §8.3)
//
// - クライアントID は固定の reray-server、永続セッション(clean = false)。
//   サーバーが止まっている間の QoS 1 は、ブローカーが溜めておき、つなぎ直したときに渡してくれる。
// - **受け取りの返事(PUBACK)は、処理(保存)が終わってから返す。** 保存の前に落ちても、
//   返事をしていないので、ブローカーがもう一度渡してくれる(重複は Receiver が捨てる)。

import mqtt, { type MqttClient } from "mqtt";
import type { Config } from "../config.js";
import { UP_ALL } from "../protocol/topics.js";

export const CLIENT_ID = "reray-server";

export type MessageHandler = (topic: string, payload: Buffer) => Promise<unknown>;

export function connectMqtt(
  config: Config,
  onMessage: MessageHandler,
  log: Pick<Console, "info" | "warn" | "error"> = console,
): MqttClient {
  const client = mqtt.connect(config.mqttUrl, {
    clientId: CLIENT_ID,
    clean: false,
    protocolVersion: 4, // MQTT 3.1.1(端末のライブラリに合わせる)
    keepalive: 30,
    reconnectPeriod: 2000,
    ...(config.mqttUser && { username: config.mqttUser }),
    ...(config.mqttPass && { password: config.mqttPass }),
  });

  // MQTT.js は handleMessage の callback を呼んでから PUBACK を送る(QoS 0 は返事なし)
  client.handleMessage = (packet, callback) => {
    onMessage(packet.topic, packet.payload as Buffer).then(
      () => callback(),
      (err: unknown) => {
        // 返事をしないので、つなぎ直したときにもう一度届く
        log.error(`処理できなかった(返事をしない): ${packet.topic}`, err);
        callback(err instanceof Error ? err : new Error(String(err)));
      },
    );
  };

  client.on("connect", (ack) => {
    log.info(`MQTT につながった(${config.mqttUrl}、前のセッション: ${ack.sessionPresent ? "あり" : "なし"})`);
    // 永続セッションなら購読は残っているが、ブローカーが消えたときのために毎回し直す
    client.subscribe(UP_ALL, { qos: 1 }, (err) => {
      if (err) log.error(`購読できなかった: ${UP_ALL}`, err);
    });
  });
  client.on("reconnect", () => log.warn("MQTT につなぎ直しています"));
  client.on("error", (err) => log.error("MQTT のエラー", err));

  return client;
}

/** QoS 1・retain なしで流す。ブローカーが受け取ったら解決する */
export function publisher(client: MqttClient) {
  return async (topic: string, payload: string): Promise<void> => {
    await client.publishAsync(topic, payload, { qos: 1, retain: false });
  };
}

/** PUBACK を待つ上限(画面から送るとき。これを過ぎたら流せなかったことにする) */
const PUBLISH_TIMEOUT_MS = 5000;

/**
 * 画面から送る用(Sender)。**ブローカーにつながっていなければ待たずに失敗する**(MQTT.js は切れている間の
 * publish を溜めて待つので、そのままだと API が返事をしない)。2026-11-06 追加
 */
export function strictPublisher(client: MqttClient) {
  return async (topic: string, payload: string): Promise<void> => {
    if (!client.connected) throw new Error("not connected to broker");
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("PUBACK timeout")), PUBLISH_TIMEOUT_MS);
    });
    try {
      await Promise.race([client.publishAsync(topic, payload, { qos: 1, retain: false }), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
}
