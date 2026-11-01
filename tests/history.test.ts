import { describe, expect, it } from "vitest";
import { createHistory, type ToneRecord } from "../src/history.js";
import { memoryStorage } from "./reflection-helpers.js";

const now = 4_000_000_000;
const day = 24 * 60 * 60 * 1000;
const entry = (sessionID: string, messageID: string, time = now): ToneRecord => ({
  version: 1, sessionID, messageID, text: `wording-${messageID}`, score: 2.5, outcome: "allowed", model: "fixture-model", time,
});
const key = (record: ToneRecord) => `reflection/v1/${encodeURIComponent(record.sessionID)}/${encodeURIComponent(record.messageID)}`;

describe("reflection history with test-owned storage and clock", () => {
  it("deduplicates stable IDs under concurrent writes and clears only the chosen session", async () => {
    const { storage } = memoryStorage();
    const history = createHistory(storage, () => now);
    const first = entry("ses_a", "msg_one");
    const other = entry("ses_b", "msg_two");
    await Promise.all([history.write(first), history.write({ ...first }), history.write(other)]);
    expect(await history.read("ses_a")).toEqual([first]);
    expect(await history.read("ses_b")).toEqual([other]);
    await history.clear("ses_a");
    expect(await history.read("ses_a")).toEqual([]);
    expect(await history.read("ses_b")).toEqual([other]);
  });

  it("prunes expired, future and malformed data and limits retained and returned records", async () => {
    const { storage, data } = memoryStorage();
    const expired = entry("ses_other", "expired", now - 30 * day - 1);
    const future = entry("ses_other", "future", now + 1);
    data.set(key(expired), { ...expired }); data.set(key(future), { ...future });
    data.set("reflection/v1/bad/entry", { version: 1, score: "bad" });
    for (let index = 0; index < 205; index++) {
      const item = entry("ses_a", `msg_${String(index).padStart(3, "0")}`, now - index);
      data.set(key(item), { ...item });
    }
    const history = createHistory(storage, () => now);
    const records = await history.read("ses_a");
    expect(records.map(record => record.messageID)).toEqual(Array.from({ length: 10 }, (_, index) => `msg_${String(index).padStart(3, "0")}`));
    expect(data.size).toBe(200);
    expect(data.has(key(expired))).toBe(false);
    expect(data.has(key(future))).toBe(false);
    expect(data.has("reflection/v1/bad/entry")).toBe(false);
  });

  it("keeps an entry at the exact age boundary", async () => {
    const { storage, data } = memoryStorage();
    const item = entry("ses_a", "edge", now - 30 * day);
    data.set(key(item), { ...item });
    expect(await createHistory(storage, () => now).read("ses_a")).toEqual([item]);
  });
});
