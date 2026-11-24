// 設定(.env から読む。値の意味は .env.example)
// 2026-11-06: 保存先(STORAGE)、MySQL、HTTP のポート、テスト用の操作(DEV_TOOLS)を足した
// 2026-11-24: 文字起こし(STT_*)と音声の置き場所(VOICE_DIR)、LoRa の署名の鍵(RERAY_HMAC_KEY)を足した

import { parseHmacKey } from "./lora/frame.js";

export interface Config {
  mqttUrl: string;
  mqttUser: string | undefined;
  mqttPass: string | undefined;
  /** memory = メモリ版(再起動で消える)、mysql = MySQL 版 */
  storage: "memory" | "mysql";
  db: { host: string; port: number; user: string; password: string; database: string };
  /** HTTP API と管理画面のポート */
  httpPort: number;
  /** 管理画面の「テスト用」の欄と、サーバーの中の偽の端末を使うか(既定は使わない) */
  devTools: boolean;
  /** DEV_TOOLS のとき、起動時につなぐ偽の端末 */
  devFakes: string[];
  /**
   * 【案】文字起こし(2026-11-24)。url が無ければ仮の文字起こし(「(音声 3 秒)」)。
   * 自宅サーバーの faster-whisper(compose.yaml の stt)なら http://localhost:8000、
   * 外のサービスなら https://api.openai.com と apiKey
   */
  stt: { url: string | undefined; model: string; apiKey: string | undefined; language: string };
  /** 【案】端末から届いた音声のファイルを置くフォルダー */
  voiceDir: string;
  /** 【案】LoRa のフレームの署名の鍵(RERAY_HMAC_KEY、16 進)。無ければ出口の生渡しはすべて捨てる */
  loraKey: Buffer | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const storage = env.STORAGE || "memory";
  if (storage !== "memory" && storage !== "mysql") {
    throw new Error(`STORAGE は memory か mysql です(今の値: ${storage})`);
  }
  return {
    mqttUrl: env.MQTT_URL || "mqtt://localhost:1883",
    mqttUser: env.MQTT_USER || undefined,
    mqttPass: env.MQTT_PASS || undefined,
    storage,
    db: {
      host: env.DB_HOST || "localhost",
      port: Number(env.DB_PORT) || 3307,
      user: env.DB_USER || "reray",
      password: env.DB_PASS ?? "",
      database: env.DB_NAME || "reray",
    },
    httpPort: Number(env.HTTP_PORT) || 3000,
    devTools: env.DEV_TOOLS === "1",
    devFakes: (env.DEV_FAKES ?? "dev-001,dev-002,dev-003")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    stt: {
      url: env.STT_URL || undefined,
      model: env.STT_MODEL || "Systran/faster-whisper-small",
      apiKey: env.STT_API_KEY || undefined,
      language: env.STT_LANGUAGE || "ja",
    },
    voiceDir: env.VOICE_DIR || "data/voice",
    loraKey: parseHmacKey(env.RERAY_HMAC_KEY),
  };
}
