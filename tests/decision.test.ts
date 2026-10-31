import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyTone, type ClassificationRequest } from "../src/decision.js";
import type { Tone } from "../src/tone.js";

const labels: readonly Tone[] = ["kind", "neutral", "frustrated", "rude", "abusive"];
const message = "Test-owned current message";
const request = (overrides: Partial<ClassificationRequest> = {}): ClassificationRequest => ({
  text: message, deadline: Date.now() + 10_000, ...overrides,
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const answer = (tone: unknown) => ({ answers: { tone } });
const fakeFetch = (handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch => handler;
const successfulFetch = (body: unknown): typeof fetch => fakeFetch(async () => response(body));

afterEach(() => vi.useRealTimers());

describe("Decision choice client", () => {
  it("posts only the current message and the fixed five-label choice contract", async () => {
    let url: string | undefined;
    let init: RequestInit | undefined;
    const fetch = fakeFetch(async (input, options) => {
      url = String(input);
      init = options;
      return response(answer({ type: "choice", choice: "neutral" }));
    });
    const result = await classifyTone(request(), { fetch });
    expect(result).toEqual({ status: "classified", tone: "neutral" });
    expect(url).toBe("http://localhost:11434/v1/systemone");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toContain("application/json");
    expect(typeof init?.body).toBe("string");
    const body: unknown = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: "d3", state: message, questions: { tone: { type: "choice", instructions: expect.any(String) } } });
    const parsed = body as { questions: { tone: { instructions: string; criteria: Record<string, unknown> } } };
    expect(parsed.questions.tone.instructions.trim()).not.toBe("");
    expect(Object.keys(parsed.questions.tone.criteria).sort()).toEqual([...labels].sort());
    for (const label of labels) expect(parsed.questions.tone.criteria[label]).toEqual(expect.any(String));
    for (const label of labels) expect(String(parsed.questions.tone.criteria[label]).trim()).not.toBe("");
    expect(Object.keys(body as object).sort()).toEqual(["model", "questions", "state"]);
  });

  it("uses the supplied endpoint and model", async () => {
    const fetch = vi.fn(fakeFetch(async () => response(answer({ type: "choice", choice: "kind" }))));
    await classifyTone(request({ endpoint: "http://example.test/decision", model: "test-model" }), { fetch });
    expect(String(fetch.mock.calls[0]?.[0])).toBe("http://example.test/decision");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ model: "test-model" });
  });

  it.each(labels)("accepts the %s label even with low confidence", async tone => {
    const result = await classifyTone(request(), { fetch: successfulFetch(answer({ type: "choice", choice: tone, confidence: 0 })) });
    expect(result).toEqual({ status: "classified", tone });
  });

  it.each([
    null, {}, { answers: null }, { answers: {} }, answer(null),
    answer({ error: { type: "question_error" } }),
    answer({ type: "noul", choice: "kind" }), answer({ type: "choice" }),
    answer({ type: "choice", choice: "unknown" }), answer({ type: "choice", choice: 3 }),
    { error: { message: "failed" }, answers: { tone: { type: "choice", choice: "kind" } } },
  ])("returns unavailable for invalid response %#", async body => {
    expect(await classifyTone(request(), { fetch: successfulFetch(body) })).toEqual({ status: "unavailable", reason: "invalid-response" });
  });

  it("returns unavailable on malformed JSON", async () => {
    const fetch = fakeFetch(async () => new Response("{broken", { status: 200 }));
    expect(await classifyTone(request(), { fetch })).toEqual({ status: "unavailable", reason: "invalid-response" });
  });

  it("returns unavailable on HTTP and transport errors without exposing upstream text", async () => {
    expect(await classifyTone(request(), { fetch: fakeFetch(async () => response({ error: "secret" }, 503)) }))
      .toEqual({ status: "unavailable", reason: "http" });
    expect(await classifyTone(request(), { fetch: fakeFetch(async () => { throw new Error("secret"); }) }))
      .toEqual({ status: "unavailable", reason: "transport" });
  });

  it("releases an unfinished HTTP error response without waiting for its body", async () => {
    let outbound: AbortSignal | null | undefined;
    // Cancellation itself never completes: the caller must not await a drain
    // or an uncooperative stream's cleanup before reporting the HTTP error.
    const cancelBody = vi.fn(() => new Promise<void>(() => {}));
    const fetch = fakeFetch(async (_input, init) => {
      outbound = init?.signal;
      return new Response(new ReadableStream({ cancel: cancelBody }), { status: 503 });
    });

    expect(await classifyTone(request(), { fetch })).toEqual({ status: "unavailable", reason: "http" });
    expect(outbound).toBeDefined();
    expect(outbound?.aborted || cancelBody.mock.calls.length > 0).toBe(true);
  }, 1000);

  it("does not start an already cancelled or expired operation", async () => {
    const fetch = vi.fn(fakeFetch(async () => response({})));
    const controller = new AbortController();
    controller.abort();
    expect(await classifyTone(request({ signal: controller.signal }), { fetch })).toEqual({ status: "unavailable", reason: "cancelled" });
    expect(await classifyTone(request({ deadline: Date.now() - 1 }), { fetch })).toEqual({ status: "unavailable", reason: "timeout" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts the request and settles on cancellation even if fetch ignores abort", async () => {
    const controller = new AbortController();
    let outbound: AbortSignal | null | undefined;
    const fetch = fakeFetch((_input, init) => { outbound = init?.signal; return new Promise(() => {}); });
    const pending = classifyTone(request({ signal: controller.signal }), { fetch });
    controller.abort();
    expect(await pending).toEqual({ status: "unavailable", reason: "cancelled" });
    expect(outbound?.aborted).toBe(true);
  });

  it("enforces the shared absolute deadline even if fetch ignores abort", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let outbound: AbortSignal | null | undefined;
    const fetch = fakeFetch((_input, init) => { outbound = init?.signal; return new Promise(() => {}); });
    const pending = classifyTone(request({ deadline: 1_250 }), { fetch });
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toEqual({ status: "unavailable", reason: "timeout" });
    expect(outbound?.aborted).toBe(true);
  });

  it("applies the deadline to response body consumption too", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    let outbound: AbortSignal | null | undefined;
    const fetch = fakeFetch(async (_input, init) => {
      outbound = init?.signal;
      return new Response(new ReadableStream({ start() {} }), { status: 200 });
    });
    const pending = classifyTone(request({ deadline: 2_250 }), { fetch });
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toEqual({ status: "unavailable", reason: "timeout" });
    expect(outbound?.aborted).toBe(true);
  });
});
