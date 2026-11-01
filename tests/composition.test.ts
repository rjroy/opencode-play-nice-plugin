import { afterEach, describe, expect, it, vi } from "vitest";
import type { Plugin } from "@opencode/plugin";
import type { SessionPrompt } from "@opencode/plugin/promise/session";
import server from "../src/server.js";
import type { FeedbackEvent } from "../src/rpc.js";

const scores = [0, 1, 1.49, 1.5, 2, 3, 4] as const;
const privateText = "fixture-private-message";
const privateError = "fixture-private-upstream-error";

function fetchTone(score: number): typeof fetch {
  return async () => new Response(JSON.stringify({ answers: { tone: { type: "score", score } } }), { status: 200 });
}

async function harness(
  options: Record<string, unknown>,
  fetch: typeof globalThis.fetch,
  autoReceipt = true,
  getSession: (input: { sessionID: string }) => Promise<{ parentID?: string }> = async () => ({}),
) {
  vi.stubGlobal("fetch", fetch);
  const logs = vi.spyOn(console, "info").mockImplementation(() => {});
  let hook: ((event: SessionPrompt) => Promise<void> | void) | undefined;
  let receipt: ((value: { invocationID: string; displayed: boolean }, context: { signal: AbortSignal }) => Promise<{ accepted: boolean }>) | undefined;
  const feedback: FeedbackEvent[] = [];
  const context = {
    options,
    rpc: { register: async (_definition: unknown, handlers: { receipt: typeof receipt }) => {
      receipt = handlers.receipt;
      return { dispose: async () => {}, events: { emit: async (_name: string, data: FeedbackEvent) => {
        feedback.push(data);
        if (autoReceipt && receipt) await receipt({ invocationID: data.invocationID, displayed: true }, { signal: new AbortController().signal });
      } } };
    } },
    session: {
      get: getSession,
      hook: async (_name: string, callback: typeof hook) => { hook = callback; return { dispose: async () => {} }; },
    },
  };
  const definition: Plugin.Plugin = server;
  const dispose = await definition.setup(context as unknown as Plugin.Context);
  if (!hook || !receipt) throw new Error("default server did not register prompt and feedback handlers");
  const registeredHook = hook;
  const registeredReceipt = receipt;
  return {
    feedback, logs,
    submit: () => Promise.resolve(registeredHook({ sessionID: "ses_fixture", messageID: "msg_fixture", prompt: { text: privateText }, delivery: "queue" } as unknown as SessionPrompt)),
    acknowledge: (event: FeedbackEvent, displayed: boolean) => registeredReceipt({ invocationID: event.invocationID, displayed }, { signal: new AbortController().signal }),
    close: async () => { await dispose?.(); },
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("default server policy composition", () => {
  it("bypasses both classification and feedback for a child session", async () => {
    const fetch = vi.fn(fetchTone(1));
    const getSession = vi.fn(async (_input: { sessionID: string }) => ({ parentID: "ses_parent" }));
    const fixture = await harness({ autoReject: true }, fetch, true, getSession);
    try {
      await expect(fixture.submit()).resolves.toBeUndefined();
      expect(getSession).toHaveBeenCalledWith({ sessionID: "ses_fixture" });
      expect(fetch).not.toHaveBeenCalled();
      expect(fixture.feedback).toHaveLength(0);
    } finally { await fixture.close(); }
  });

  it("still classifies and rejects a top-level session with feedback", async () => {
    const fetch = vi.fn(fetchTone(1));
    const getSession = vi.fn(async (_input: { sessionID: string }) => ({}));
    const fixture = await harness({ autoReject: true }, fetch, true, getSession);
    try {
      await expect(fixture.submit()).rejects.toThrow();
      expect(getSession).toHaveBeenCalledWith({ sessionID: "ses_fixture" });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fixture.feedback).toHaveLength(1);
      expect(fixture.feedback[0]?.outcome).toBe("blocked");
    } finally { await fixture.close(); }
  });

  it("retains classification and rejection feedback if session lookup fails", async () => {
    const fetch = vi.fn(fetchTone(1));
    const getSession = vi.fn(async (_input: { sessionID: string }): Promise<{ parentID?: string }> => {
      throw new Error("fixture lookup failure");
    });
    const fixture = await harness({ autoReject: true }, fetch, true, getSession);
    try {
      await expect(fixture.submit()).rejects.toThrow();
      expect(getSession).toHaveBeenCalledWith({ sessionID: "ses_fixture" });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fixture.feedback).toHaveLength(1);
      expect(fixture.feedback[0]?.outcome).toBe("blocked");
    } finally { await fixture.close(); }
  });

  it("enforces within the shared deadline after lookup timeout and ignores a late child result", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    let resolveLookup: (session: { parentID?: string }) => void = () => { throw new Error("lookup not started"); };
    const getSession = vi.fn((_input: { sessionID: string }) => new Promise<{ parentID?: string }>(resolve => {
      resolveLookup = resolve;
    }));
    const fetch = vi.fn(fetchTone(1));
    const fixture = await harness({ autoReject: true, timeoutMs: 1000 }, fetch, true, getSession);
    try {
      const pending = fixture.submit().then(() => "allowed", () => "rejected");
      expect(getSession).toHaveBeenCalledWith({ sessionID: "ses_fixture" });
      await vi.advanceTimersByTimeAsync(999);
      expect(await pending).toBe("rejected");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fixture.feedback).toHaveLength(1);
      expect(fixture.feedback[0]?.outcome).toBe("blocked");

      resolveLookup({ parentID: "ses_parent" });
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fixture.feedback).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { await fixture.close(); }
  });

  it("cancels a pending session lookup when the plugin closes", async () => {
    const fetch = vi.fn(fetchTone(1));
    const getSession = vi.fn((_input: { sessionID: string }): Promise<{ parentID?: string }> => new Promise(() => {}));
    const fixture = await harness({ autoReject: true }, fetch, true, getSession);
    const pending = fixture.submit().then(() => "allowed", () => "rejected");
    let closed = false;
    try {
      await vi.waitFor(() => expect(getSession).toHaveBeenCalledTimes(1));
      await fixture.close();
      closed = true;
      expect(await pending).toBe("rejected");
      expect(fetch).not.toHaveBeenCalled();
      expect(fixture.feedback).toHaveLength(0);
    } finally { if (!closed) await fixture.close(); }
  });

  it.each(scores)("reports score %s while allowing by default", async score => {
    const fixture = await harness({}, fetchTone(score));
    try {
      await expect(fixture.submit()).resolves.toBeUndefined();
      expect(fixture.feedback).toHaveLength(1);
      expect(fixture.feedback[0]?.message).toContain(String(score));
      expect(fixture.feedback[0]?.outcome).toBe("allowed");
    } finally { await fixture.close(); }
  });

  it.each([[0, "blocked"], [1, "blocked"], [1.49, "blocked"], [1.5, "allowed"], [1.51, "allowed"], [4, "allowed"]] as const)(
    "enforces the default cutoff for score %s", async (score, outcome) => {
      const fixture = await harness({ autoReject: true }, fetchTone(score));
      try {
        const result = await fixture.submit().then(() => "allowed", () => "blocked");
        expect(result).toBe(outcome);
        expect(fixture.feedback[0]?.outcome).toBe(outcome);
      } finally { await fixture.close(); }
    },
  );

  it("awaits rejection feedback receipt before rejecting an opted-in score", async () => {
    const fixture = await harness({ autoReject: true }, fetchTone(1), false);
    try {
      let settled = false;
      const pending = fixture.submit().then(() => { settled = true; return "allowed"; }, () => { settled = true; return "rejected"; });
      await vi.waitFor(() => expect(fixture.feedback).toHaveLength(1));
      expect(fixture.feedback[0]?.message).toContain("1");
      expect(fixture.feedback[0]?.outcome).toBe("blocked");
      expect(settled).toBe(false);
      const event = fixture.feedback[0];
      if (!event) throw new Error("missing feedback");
      expect((await fixture.acknowledge(event, true)).accepted).toBe(true);
      expect(await pending).toBe("rejected");
    } finally { await fixture.close(); }
  });

  it.each([[2.24, "blocked"], [2.25, "allowed"], [2.26, "allowed"]] as const)(
    "uses configured fractional cutoff for score %s", async (score, outcome) => {
      const fixture = await harness({ autoReject: true, rejectBelowScore: 2.25 }, fetchTone(score));
      try {
        expect(await fixture.submit().then(() => "allowed", () => "blocked")).toBe(outcome);
        expect(fixture.feedback[0]?.outcome).toBe(outcome);
      } finally { await fixture.close(); }
    },
  );

  it("passes context options and the current prompt to the Decision client", async () => {
    let url: string | undefined;
    let body: unknown;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      url = String(input);
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ answers: { tone: { type: "score", score: 3 } } }));
    };
    const fixture = await harness({ endpoint: "http://fixture.test/decision", model: "fixture-model" }, fetch);
    try {
      await fixture.submit();
      expect(url).toBe("http://fixture.test/decision");
      expect(body).toMatchObject({ model: "fixture-model", state: privateText });
    } finally { await fixture.close(); }
  });

  it("fails open with unavailable feedback on classification errors without logging private data", async () => {
    const fetch: typeof globalThis.fetch = async () => { throw new Error(privateError); };
    const fixture = await harness({ autoReject: true, endpoint: "http://fixture.test/secret-path" }, fetch);
    try {
      await expect(fixture.submit()).resolves.toBeUndefined();
      expect(fixture.feedback[0]?.message.toLowerCase()).toContain("unavailable");
      const logs = JSON.stringify(fixture.logs.mock.calls);
      expect(logs).not.toContain(privateText);
      expect(logs).not.toContain(privateError);
      expect(logs).not.toContain("secret-path");
      expect(logs).toMatch(/classif|scor/i);
    } finally { await fixture.close(); }
  });

  it.each(["1.2", -0.01, 4.01, null])("fails open on an invalid score %#", async score => {
    const fetch: typeof globalThis.fetch = async () => new Response(JSON.stringify({ answers: { tone: { type: "score", score } } }));
    const fixture = await harness({ autoReject: true }, fetch);
    try {
      await expect(fixture.submit()).resolves.toBeUndefined();
      expect(fixture.feedback[0]?.outcome).toBe("allowed");
      expect(fixture.feedback[0]?.message.toLowerCase()).toContain("unavailable");
    } finally { await fixture.close(); }
  });

  it("still rejects when the rejection toast fails and does not call that a classifier failure", async () => {
    const fixture = await harness({ autoReject: true }, fetchTone(0), false);
    try {
      const pending = fixture.submit();
      const settled = pending.then(() => "allowed", () => "rejected");
      await vi.waitFor(() => expect(fixture.feedback).toHaveLength(1));
      const event = fixture.feedback[0];
      if (!event) throw new Error("missing feedback");
      await fixture.acknowledge(event, false);
      expect(await settled).toBe("rejected");
      expect(fixture.feedback).toHaveLength(1);
      expect(JSON.stringify(fixture.logs.mock.calls)).toMatch(/feedback.*unavailable/i);
    } finally { await fixture.close(); }
  });

  it("reserves feedback time and finishes within the shared deadline when classification hangs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    let outbound: AbortSignal | null | undefined;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      outbound = init?.signal;
      return new Promise(() => {});
    };
    const fixture = await harness({ autoReject: true, timeoutMs: 1000 }, fetch);
    try {
      const pending = fixture.submit();
      await vi.advanceTimersByTimeAsync(999);
      expect(fixture.feedback).toHaveLength(1);
      expect(fixture.feedback[0]?.message.toLowerCase()).toContain("unavailable");
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBeUndefined();
      expect(outbound?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { await fixture.close(); }
  });

  it("rejects by the shared deadline if no rejection receipt arrives and ignores a late receipt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    const fixture = await harness({ autoReject: true, timeoutMs: 1000 }, fetchTone(1), false);
    try {
      const pending = fixture.submit().then(() => "allowed", () => "rejected");
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toBe("rejected");
      const event = fixture.feedback[0];
      if (!event) throw new Error("missing rejection feedback");
      expect((await fixture.acknowledge(event, true)).accepted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally { await fixture.close(); }
  });
});
