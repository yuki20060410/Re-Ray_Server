// 設定(.env から読む。値の意味は .env.example)
// 2026-11-06: 保存先(STORAGE)、MySQL、HTTP のポート、テスト用の操作(DEV_TOOLS)を足した

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
  };
}
