import { afterEach, describe, expect, it, vi } from "vitest";
import type { StorageDomain } from "@opencode/plugin/promise/storage";
import { deferred, memoryStorage, reflectionHarness } from "./reflection-helpers.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("reflection admission and commands", () => {
  it("records range endpoints and fractional blocked scores, but not outside or unavailable scores", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { storage, data } = memoryStorage();
    const values = new Map<string, { outcome: "allowed" | "blocked"; message: string; score: number | undefined; model: string }>([
      ["below", { outcome: "allowed" as const, message: "evaluated", score: 1.99, model: "test" }],
      ["lower", { outcome: "allowed" as const, message: "evaluated", score: 2, model: "test" }],
      ["fraction", { outcome: "blocked" as const, message: "evaluated", score: 2.5, model: "test" }],
      ["upper", { outcome: "allowed" as const, message: "evaluated", score: 3, model: "test" }],
      ["above", { outcome: "allowed" as const, message: "evaluated", score: 3.01, model: "test" }],
      ["unavailable", { outcome: "allowed" as const, message: "unavailable", score: undefined, model: "test" }],
    ]);
    const fixture = await reflectionHarness({ storage, classify: async text => {
      const value = values.get(text);
      if (!value) throw new Error("unexpected classifier request");
      return value;
    } });
    try {
      for (const text of values.keys()) {
        const outcome = await fixture.submit("ses_a", `msg_${text}`, text).then(() => "allowed", () => "blocked");
        expect(outcome).toBe(text === "fraction" ? "blocked" : "allowed");
      }
      expect([...data.values()].map(value => {
        const item = JSON.parse(JSON.stringify(value)) as { text: string; score: number; outcome: string };
        return [item.text, item.score, item.outcome];
      }))
        .toEqual([["lower", 2, "allowed"], ["fraction", 2.5, "blocked"], ["upper", 3, "allowed"]]);
    } finally { await fixture.close(); }
  });

  it("reflects multiple isolated records and preserves a focused question as untrusted evidence", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { storage } = memoryStorage();
    const classify = vi.fn(async (text: string) => ({ outcome: "allowed" as const, message: "evaluated", score: text === "first" ? 2 : 2.5, model: "test" }));
    const fixture = await reflectionHarness({ storage, classify });
    try {
      await fixture.submit("ses_a", "msg_one", "first");
      await fixture.submit("ses_a", "msg_two", "second");
      await fixture.submit("ses_b", "msg_three", "other-session-private");
      await fixture.command("ses_a", "What went wrong?");
      expect(fixture.submissions).toHaveLength(1);
      const task = fixture.submissions[0]?.text ?? "";
      expect(task).toContain("first"); expect(task).toContain("second");
      expect(task).toContain("2.5"); expect(task).toContain("What went wrong?");
      expect(task).toMatch(/untrusted/i);
      expect(task).not.toContain("other-session-private");
      expect(classify).toHaveBeenCalledTimes(3);
    } finally { await fixture.close(); }
  });

  it("reports storage failure without weakening rejection or starting reflection", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { storage } = memoryStorage();
    const failing: StorageDomain = { ...storage, scan: async () => { throw new Error("private storage failure"); } };
    const fixture = await reflectionHarness({ storage: failing, classify: async () => ({ outcome: "blocked", message: "evaluated", score: 2.5, model: "test" }) });
    try {
      await expect(fixture.submit("ses_a", "msg_one", "blocked")).rejects.toThrow();
      expect(fixture.feedback[0]?.message).toMatch(/history unavailable/i);
      await fixture.command("ses_a", "");
      expect(fixture.feedback.at(-1)?.message).toMatch(/unavailable/i);
      expect(fixture.submissions).toHaveLength(0);
    } finally { await fixture.close(); }
  });

  it("BTR-01 bounds stalled history operations, discards stale queued writes and recovers", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { storage, data } = memoryStorage();
    const scanGate = deferred<Awaited<ReturnType<StorageDomain["scan"]>>>();
    let scans = 0;
    const stalled: StorageDomain = { ...storage, scan: async options => ++scans === 1 ? scanGate.promise : storage.scan(options) };
    const fixture = await reflectionHarness({ storage: stalled, timeout: 50, classify: async () => ({ outcome: "allowed", message: "evaluated", score: 2.5, model: "test" }) });
    const first = fixture.submit("ses_a", "msg_first", "first").then(() => "allowed", () => "blocked");
    await vi.advanceTimersByTimeAsync(100);
    const firstOutcome = await first;
    const second = fixture.submit("ses_a", "msg_stale", "stale").then(() => "allowed", () => "blocked");
    await vi.advanceTimersByTimeAsync(100);
    const secondOutcome = await second;
    let reflected = false; let cleared = false;
    void fixture.command("ses_a", "").then(() => { reflected = true; });
    void fixture.command("ses_b", "clear").then(() => { cleared = true; });
    await vi.advanceTimersByTimeAsync(300);
    const boundedCommands = { reflected, cleared };
    const close = Promise.resolve(fixture.close());
    await vi.advanceTimersByTimeAsync(100);
    const shutdownCommands = { reflected, cleared };
    scanGate.resolve({ entries: [] });
    await vi.advanceTimersByTimeAsync(100);
    await close;
    expect(firstOutcome).toBe("allowed"); expect(secondOutcome).toBe("allowed");
    expect(boundedCommands).toEqual({ reflected: true, cleared: true });
    expect(shutdownCommands).toEqual({ reflected: true, cleared: true });
    expect([...data.values()].some(value => JSON.stringify(value).includes("stale")), "timed-out queued write must not run later").toBe(false);
  });

  it("BTR-01 resumes history after storage recovers without replaying a timed-out queued write", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { storage, data } = memoryStorage();
    const gate = deferred<Awaited<ReturnType<StorageDomain["scan"]>>>();
    let scans = 0;
    const stalled: StorageDomain = { ...storage, scan: async options => ++scans === 1 ? gate.promise : storage.scan(options) };
    const fixture = await reflectionHarness({ storage: stalled, timeout: 50, classify: async () => ({ outcome: "allowed", message: "evaluated", score: 2.5, model: "test" }) });
    try {
      const first = fixture.submit("ses_a", "msg_first", "first");
      await vi.advanceTimersByTimeAsync(100); await first;
      const stale = fixture.submit("ses_a", "msg_stale", "stale");
      await vi.advanceTimersByTimeAsync(100); await stale;
      gate.resolve({ entries: [] });
      await vi.advanceTimersByTimeAsync(100);
      const recovered = fixture.submit("ses_a", "msg_recovered", "recovered");
      await vi.advanceTimersByTimeAsync(100); await recovered;
      const contents = JSON.stringify([...data.values()]);
      expect(contents).toContain("recovered");
      expect(contents).not.toContain("stale");
    } finally { gate.resolve({ entries: [] }); await fixture.close(); }
  });

  it("BTR-02 never classifies a late internal prompt after submission times out", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { storage, data } = memoryStorage();
    const gate = deferred<void>();
    const classify = vi.fn(async () => ({ outcome: "allowed" as const, message: "evaluated", score: 2.5, model: "test" }));
    const fixture = await reflectionHarness({ storage, timeout: 50, classify, prompt: async () => gate.promise });
    try {
      await fixture.submit("ses_a", "msg_seed", "seed");
      const command = fixture.command("ses_a", "explain");
      await vi.advanceTimersByTimeAsync(100);
      await command;
      const internal = fixture.submissions[0];
      if (!internal) throw new Error("reflection submission did not start");
      // The native request is still pending, so expired provenance must reject
      // this late admission without classifying it as user text.
      const late = fixture.submit(internal.sessionID, internal.id, internal.text).then(() => "allowed", () => "rejected");
      await vi.advanceTimersByTimeAsync(100);
      expect(await late).toBe("rejected");
      gate.resolve();
      await vi.advanceTimersByTimeAsync(100);
      expect(classify).toHaveBeenCalledTimes(1);
      expect(data.size).toBe(1);
      await fixture.submit("ses_a", "msg_ordinary", "ordinary");
      expect(classify).toHaveBeenCalledTimes(2);
    } finally { gate.resolve(); await fixture.close(); }
  });

  it("settles an active reflection on unload and rejects its late hook without classifying", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { storage } = memoryStorage();
    const gate = deferred<void>();
    const classify = vi.fn(async () => ({ outcome: "allowed" as const, message: "evaluated", score: 2.5, model: "test" }));
    const fixture = await reflectionHarness({ storage, timeout: 1000, classify, prompt: async () => gate.promise });
    try {
      await fixture.submit("ses_a", "msg_seed", "seed");
      let settled = false;
      const command = fixture.command("ses_a", "explain").then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      const internal = fixture.submissions[0];
      if (!internal) throw new Error("reflection submission did not start");
      await fixture.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      await command;
      await expect(fixture.submit(internal.sessionID, internal.id, internal.text)).rejects.toThrow();
      expect(classify).toHaveBeenCalledTimes(1);
    } finally { gate.resolve(); }
  });
});
