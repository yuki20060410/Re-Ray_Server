// 「切れた」の判定(M2。ARCHITECTURE §5)
//
// - online を書き換えるのはサーバーだけ【修正案】。何か届けば true(保存の窓口が更新する)、
//   遺言は Receiver が false にする。ここは「しばらく何も届かない」ときだけを見る。
// - Wi-Fi の端末は 90 秒、LoRa の端末は 15 分。経路が分からない端末は 90 秒。
// - サーバーが止まっていたあとは、受信を少し待ってから判定を始める(再起動直後に一斉に「切れた」にしない)【追加案】。
// 2026-11-06 作成(reray-app の mqtt-bridge.js の checkTimeouts を、窓口を使う形で取り込んだ)

import type { DeviceId, Storage } from "../storage/types.js";

/** 90 秒・15 分は【修正案】の値。実機の status の間隔が決まったら直す(定数はここだけ) */
export const WIFI_TIMEOUT_MS = 90 * 1000;
export const LORA_TIMEOUT_MS = 15 * 60 * 1000;
/** 判定の間隔 */
export const CHECK_INTERVAL_MS = 10 * 1000;
/** 起動してから判定を始めるまで(status は 30 秒おき【案】なので、それより長く) */
export const STARTUP_GRACE_MS = 45 * 1000;

export interface PresenceDeps {
  storage: Storage;
  now?: () => Date;
  log?: Pick<Console, "info" | "warn" | "error">;
}

export class Presence {
  private readonly storage: Storage;
  private readonly now: () => Date;
  private readonly log: NonNullable<PresenceDeps["log"]>;
  private readonly startedAt: number;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(deps: PresenceDeps) {
    this.storage = deps.storage;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? console;
    this.startedAt = this.now().getTime();
  }

  /** 1 回判定する。「切れた」にした端末を返す */
  async check(): Promise<DeviceId[]> {
    const now = this.now();
    if (now.getTime() - this.startedAt < STARTUP_GRACE_MS) return [];

    const changed: DeviceId[] = [];
    for (const d of await this.storage.listDevices()) {
      if (!d.online || !d.lastSeenAt) continue;
      const limit = d.via === "lora" ? LORA_TIMEOUT_MS : WIFI_TIMEOUT_MS;
      const cutoff = new Date(now.getTime() - limit);
      if (d.lastSeenAt.getTime() >= cutoff.getTime()) continue;
      // 判定のあいだに届いた分は「切れた」にしない(cutoff より後に届いていれば窓口が変えない)
      if (await this.storage.markOffline(d.id, "timeout", now, cutoff)) changed.push(d.id);
    }
    if (changed.length) this.log.info(`しばらく届かないので「切れた」にした: ${changed.join(", ")}`);
    return changed;
  }

  start(): void {
    this.timer = setInterval(() => {
      if (this.running) return; // 前の判定が終わっていなければ飛ばす
      this.running = true;
      this.check()
        .catch((err: unknown) => this.log.error("「切れた」の判定に失敗した", err))
        .finally(() => {
          this.running = false;
        });
    }, CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
