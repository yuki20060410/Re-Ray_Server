// 設定(.env から読む。値の意味は .env.example)

export interface Config {
  mqttUrl: string;
  mqttUser: string | undefined;
  mqttPass: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    mqttUrl: env.MQTT_URL || "mqtt://localhost:1883",
    mqttUser: env.MQTT_USER || undefined,
    mqttPass: env.MQTT_PASS || undefined,
  };
}
