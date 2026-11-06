import assert from "node:assert/strict";
import { it } from "node:test";
import { runStorageContract } from "./contract.js";
import { MemoryStorage } from "./memory.js";

runStorageContract("メモリ", async () => new MemoryStorage());

// メモリ版だけで見られること
it("原本の結果を書き換えられる(メモリ版)", async () => {
  const s = new MemoryStorage();
  const id = await s.saveEvent({
    at: new Date(0),
    direction: "up",
    topic: "reray/v1/up/dev-001/signal",
    payload: "{",
    result: "pending",
  });
  await s.setEventResult(id, "invalid", "json");
  assert.equal(s.events[0]?.result, "invalid");
  assert.equal(s.events[0]?.note, "json");
});
