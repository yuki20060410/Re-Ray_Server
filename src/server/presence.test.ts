// 「切れた」の判定(M2)のテスト。時計を手で進める(2026-11-06 作成)

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStorage } from "../storage/memory.js";
import { LORA_TIMEOUT_MS, Presence, STARTUP_GRACE_MS, WIFI_TIMEOUT_MS } from "./presence.js";

const T0 = Date.parse("2026-11-06T00:00:00.000Z");
const quiet = { info() {}, warn() {}, error() {} };

function setup() {
  const storage = new MemoryStorage();
  let now = T0;
  const presence = new Presence({ storage, now: () => new Date(now), log: quiet });
  return {
    storage,
    presence,
    set(ms: number) {
      now = T0 + ms;
    },
  };
}

describe("切れた の判定", () => {
  it("Wi-Fi は 90 秒、LoRa は 15 分、経路が分からなければ 90 秒で「切れた」", async () => {
    const { storage, presence, set } = setup();
    const t = new Date(T0 + STARTUP_GRACE_MS);
    await storage.recordStatus({ deviceId: "dev-001", receivedAt: t, via: "wifi" });
    await storage.recordStatus({ deviceId: "dev-002", receivedAt: t, via: "lora" });
    await storage.touchDevice("dev-003", t);

    set(STARTUP_GRACE_MS + WIFI_TIMEOUT_MS);
    assert.deepEqual(await presence.check(), []); // ちょうどはまだ
    set(STARTUP_GRACE_MS + WIFI_TIMEOUT_MS + 1);
    assert.deepEqual(await presence.check(), ["dev-001", "dev-003"]);
    set(STARTUP_GRACE_MS + LORA_TIMEOUT_MS + 1);
    assert.deepEqual(await presence.check(), ["dev-002"]);

    assert.deepEqual(
      storage.offlines.map((o) => [o.deviceId, o.cause]),
      [
        ["dev-001", "timeout"],
        ["dev-003", "timeout"],
        ["dev-002", "timeout"],
      ],
    );
    // last_seen_at は変えない
    assert.deepEqual((await storage.getDevice("dev-001"))?.lastSeenAt, t);
  });

  it("起動してしばらくは判定しない(再起動直後に一斉に「切れた」にしない)", async () => {
    const { storage, presence, set } = setup();
    await storage.recordStatus({ deviceId: "dev-001", receivedAt: new Date(T0 - 10 * 60 * 1000) });
    set(STARTUP_GRACE_MS - 1);
    assert.deepEqual(await presence.check(), []);
    set(STARTUP_GRACE_MS);
    assert.deepEqual(await presence.check(), ["dev-001"]);
  });

  it("届き続けていれば、つながったまま", async () => {
    const { storage, presence, set } = setup();
    for (let s = 0; s <= 300; s += 30) {
      set(STARTUP_GRACE_MS + s * 1000);
      await storage.recordStatus({ deviceId: "dev-001", receivedAt: new Date(T0 + STARTUP_GRACE_MS + s * 1000) });
      assert.deepEqual(await presence.check(), []);
    }
  });
});
