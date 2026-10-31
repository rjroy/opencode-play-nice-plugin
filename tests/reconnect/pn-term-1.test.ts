import { OpenCode } from "@opencode/client";
import { afterEach, expect, it, vi } from "vitest";
import productionTui from "opencode-play-nice-plugin/tui";
import { recordingTuiContext, type RecordedToast } from "../native/production-tui.js";
import { controlledSse, feedback, location, reconnectingHost, type Termination } from "./controlled-sse.js";

const recoveryBudgetMs = 5000; // A test safety bound, not an assertion of one particular retry tuning.

async function driveUntil(predicate: () => boolean, budgetMs = recoveryBudgetMs): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  await vi.advanceTimersByTimeAsync(0);
  while (!predicate() && Date.now() < deadline) await vi.advanceTimersByTimeAsync(Math.min(25, deadline - Date.now()));
  return predicate();
}

async function stopped(work: Promise<void>, label: string) {
  const result: { done: boolean; failed: boolean; error?: unknown } = { done: false, failed: false };
  void work.then(() => { result.done = true; }, error => { result.done = true; result.failed = true; result.error = error; });
  expect(await driveUntil(() => result.done, 100), `${label} must cancel rather than await its retry deadline`).toBe(true);
  if (result.failed) throw result.error;
}

function setup(autoTerminate: readonly Termination[] = [], withHost = false) {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(10000);
  const transport = controlledSse(autoTerminate);
  const client = OpenCode.make({ baseUrl: transport.origin, fetch: transport.fetch });
  const toasts: RecordedToast[] = [];
  // This is the exported PRODUCTION setup, invoked exactly once per case.
  const dispose = productionTui.setup(recordingTuiContext({
    client, location, defaultLocation: location, show: toast => { toasts.push(toast); },
  }));
  let cleanup: Promise<void> | undefined;
  const unload = () => cleanup ??= dispose();
  const host = withHost ? reconnectingHost(client) : undefined;
  return {
    transport, toasts, host, unload,
    async close() {
      try {
        // Abort both owners before awaiting either: host reconnection must not
        // race teardown, and the shared SDK stream closes with its last owner.
        const owners = [unload(), ...(host ? [host.stop()] : [])];
        await stopped(Promise.all(owners).then(() => {}), "owned TUI/host cleanup");
      } finally { transport.dispose(); vi.clearAllTimers(); vi.useRealTimers(); }
    },
  };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it.each(["eof", "error"] as const)("PN-TERM-1 restores production feedback after %s while the host reconnects without plugin reload", async termination => {
  const fixture = setup([], true);
  try {
    const host = fixture.host;
    if (!host) throw new Error("Missing owned host consumer");
    expect(await driveUntil(() => host.connected === 1)).toBe(true);
    const first = feedback(1);
    fixture.transport.current().send(first);
    expect(await driveUntil(() => fixture.toasts.length === 1 && fixture.transport.receipts.length === 1)).toBe(true);
    expect(fixture.toasts[0]).toMatchObject({ message: first.data.message, sessionID: first.data.sessionID });
    expect(fixture.transport.receipts).toEqual([{ invocationID: first.data.invocationID, displayed: true, directory: location.directory }]);

    fixture.transport.current().terminate(termination);
    expect(await driveUntil(() => host.connected >= 2 && fixture.transport.connections.length >= 2)).toBe(true);
    // A valid bounded production retry may join the host's already-open stream
    // after a delay. Do not publish the next event during that recovery window.
    await vi.advanceTimersByTimeAsync(recoveryBudgetMs);
    const second = feedback(2);
    fixture.transport.current().send(second);
    expect(await driveUntil(() => host.events.some(event => event.id === second.id))).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(host.events.filter(event => event.type === "rpc.play-nice.feedback").map(event => event.id)).toEqual([first.id, second.id]);
    expect(fixture.toasts, "PN-TERM-1: host saw the second event, but the production feedback iterator stopped permanently").toHaveLength(2);
    expect(fixture.toasts[1]).toMatchObject({ message: second.data.message, sessionID: second.data.sessionID });
    expect(fixture.transport.receipts).toEqual([
      { invocationID: first.data.invocationID, displayed: true, directory: location.directory },
      { invocationID: second.data.invocationID, displayed: true, directory: location.directory },
    ]);
    expect(host.failures).toBe(termination === "error" ? 1 : 0);

    // Distinct from recovery: after unload, the host may reconnect again but
    // the disposed plugin must never rejoin it or send another receipt.
    await stopped(fixture.unload(), "production unload");
    fixture.transport.current().terminate("eof");
    expect(await driveUntil(() => host.connected >= 3)).toBe(true);
    await vi.advanceTimersByTimeAsync(recoveryBudgetMs);
    const third = feedback(3);
    fixture.transport.current().send(third);
    expect(await driveUntil(() => host.events.some(event => event.id === third.id))).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(fixture.toasts).toHaveLength(2);
    expect(fixture.transport.receipts).toHaveLength(2);
  } finally { await fixture.close(); }
});

it("PN-TERM-1 retries repeated terminal streams with nonzero bounded backoff rather than a busy loop", async () => {
  const fixture = setup(["eof", "error", "eof"]);
  try {
    expect(await driveUntil(() => fixture.transport.connections.length >= 4, 3 * recoveryBudgetMs), "production must retry repeated recoverable terminal streams").toBe(true);
    expect(fixture.transport.connections).toHaveLength(4);
    for (let index = 1; index < fixture.transport.connections.length; index++) {
      const before = fixture.transport.connections[index - 1];
      const after = fixture.transport.connections[index];
      if (!before || !after) throw new Error("Missing owned connection timing");
      expect(after.openedAt - before.openedAt, "zero-delay terminal-stream retry is a busy loop").toBeGreaterThan(0);
      expect(after.openedAt - before.openedAt).toBeLessThanOrEqual(recoveryBudgetMs);
    }
  } finally { await fixture.close(); }
});

it.each(["eof", "error"] as const)("PN-TERM-1 unload cancels the pending %s retry and prevents later connections", async termination => {
  const fixture = setup();
  try {
    expect(await driveUntil(() => fixture.transport.connections.length === 1)).toBe(true);
    fixture.transport.current().terminate(termination);
    await vi.advanceTimersByTimeAsync(0); // Deliver terminal completion without firing a positive backoff.
    expect(fixture.transport.connections).toHaveLength(1);
    await stopped(fixture.unload(), "production unload during backoff");
    expect(vi.getTimerCount(), "unload must remove its retry timer, not merely suppress future toast calls").toBe(0);
    const count = fixture.transport.connections.length;
    await vi.advanceTimersByTimeAsync(3 * recoveryBudgetMs);
    expect(fixture.transport.connections).toHaveLength(count);
    expect(fixture.transport.connections.every(connection => connection.ended)).toBe(true);
    expect(fixture.toasts).toEqual([]);
    expect(fixture.transport.receipts).toEqual([]);
  } finally { await fixture.close(); }
});
