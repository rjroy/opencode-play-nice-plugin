import { afterEach, describe, expect, it, vi } from "vitest";
import type { Plugin } from "@opencode/plugin";
import type { SessionPrompt } from "@opencode/plugin/promise/session";
import server from "../src/server.js";
import type { FeedbackEvent } from "../src/rpc.js";
import type { Tone } from "../src/tone.js";

const tones: readonly Tone[] = ["kind", "neutral", "frustrated", "rude", "abusive"];
const privateText = "fixture-private-message";
const privateError = "fixture-private-upstream-error";

function fetchTone(tone: Tone): typeof fetch {
  return async () => new Response(JSON.stringify({ answers: { tone: { type: "choice", choice: tone } } }), { status: 200 });
}

async function harness(options: Record<string, unknown>, fetch: typeof globalThis.fetch, autoReceipt = true) {
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
    session: { hook: async (_name: string, callback: typeof hook) => { hook = callback; return { dispose: async () => {} }; } },
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
  it.each(tones)("reports %s while allowing by default", async tone => {
    const fixture = await harness({}, fetchTone(tone));
    try {
      await expect(fixture.submit()).resolves.toBeUndefined();
      expect(fixture.feedback).toHaveLength(1);
      expect(fixture.feedback[0]?.message.toLowerCase()).toContain(tone);
      expect(fixture.feedback[0]?.outcome).toBe("allowed");
    } finally { await fixture.close(); }
  });

  it("awaits rejection feedback receipt before rejecting an opted-in category", async () => {
    const fixture = await harness({ autoReject: true }, fetchTone("rude"), false);
    try {
      let settled = false;
      const pending = fixture.submit().then(() => { settled = true; return "allowed"; }, () => { settled = true; return "rejected"; });
      await vi.waitFor(() => expect(fixture.feedback).toHaveLength(1));
      expect(fixture.feedback[0]?.message.toLowerCase()).toContain("rude");
      expect(fixture.feedback[0]?.outcome).toBe("blocked");
      expect(settled).toBe(false);
      const event = fixture.feedback[0];
      if (!event) throw new Error("missing feedback");
      expect((await fixture.acknowledge(event, true)).accepted).toBe(true);
      expect(await pending).toBe("rejected");
    } finally { await fixture.close(); }
  });

  it("uses configured categories instead of blocking every negative tone", async () => {
    const fixture = await harness({ autoReject: true, rejectedCategories: ["kind"] }, fetchTone("rude"));
    try {
      await expect(fixture.submit()).resolves.toBeUndefined();
      expect(fixture.feedback[0]?.outcome).toBe("allowed");
      expect(fixture.feedback[0]?.message.toLowerCase()).toContain("rude");
    } finally { await fixture.close(); }
  });

  it("passes context options and the current prompt to the Decision client", async () => {
    let url: string | undefined;
    let body: unknown;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      url = String(input);
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ answers: { tone: { type: "choice", choice: "neutral" } } }));
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
      expect(logs).toMatch(/classification/i);
    } finally { await fixture.close(); }
  });

  it("still rejects when the rejection toast fails and does not call that a classifier failure", async () => {
    const fixture = await harness({ autoReject: true }, fetchTone("abusive"), false);
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
    const fixture = await harness({ autoReject: true, timeoutMs: 1000 }, fetchTone("rude"), false);
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
