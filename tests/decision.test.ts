import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyTone as scoreTone, type ClassificationRequest as ScoringRequest } from "../src/decision.js";

const levels = [/abus|threat|harass/i, /rude|disrespect|insult/i, /frustrat|dissatisf/i, /neutral|matter.of.fact/i, /kind|friendly|support|appreciat/i] as const;
const message = "Test-owned current message";
const request = (overrides: Partial<ScoringRequest> = {}): ScoringRequest => ({
  text: message, deadline: Date.now() + 10_000, ...overrides,
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const answer = (tone: unknown) => ({ answers: { tone } });
const fakeFetch = (handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch => handler;
const successfulFetch = (body: unknown): typeof fetch => fakeFetch(async () => response(body));

afterEach(() => vi.useRealTimers());

describe("Decision score client", () => {
  it("posts only the current message and the ordered five-level score contract", async () => {
    let url: string | undefined;
    let init: RequestInit | undefined;
    const fetch = fakeFetch(async (input, options) => {
      url = String(input);
      init = options;
      return response(answer({ type: "score", score: 3 }));
    });
    const result = await scoreTone(request(), { fetch });
    expect(result).toEqual({ status: "scored", score: 3 });
    expect(url).toBe("http://localhost:11434/v1/systemone");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toContain("application/json");
    expect(typeof init?.body).toBe("string");
    const body: unknown = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: "d3", state: message, questions: { tone: { type: "score", instructions: expect.any(String) } } });
    const parsed = body as { questions: { tone: { instructions: string; criteria: unknown[] } } };
    expect(parsed.questions.tone.instructions.trim()).not.toBe("");
    expect(parsed.questions.tone).not.toHaveProperty("levels");
    expect(Array.isArray(parsed.questions.tone.criteria)).toBe(true);
    expect(parsed.questions.tone.criteria).toHaveLength(5);
    for (const [index, level] of levels.entries()) {
      expect(parsed.questions.tone.criteria[index]).toEqual(expect.any(String));
      expect(parsed.questions.tone.criteria[index]).toMatch(level);
    }
    expect(Object.keys(body as object).sort()).toEqual(["model", "questions", "state"]);
  });

  it("uses the supplied endpoint and model", async () => {
    const fetch = vi.fn(fakeFetch(async () => response(answer({ type: "score", score: 4 }))));
    await scoreTone(request({ endpoint: "http://example.test/decision", model: "test-model" }), { fetch });
    expect(String(fetch.mock.calls[0]?.[0])).toBe("http://example.test/decision");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ model: "test-model" });
  });

  it.each([0, 1, 1.49, 1.5, 2, 3, 3.75, 4])("preserves score %s even with low confidence", async score => {
    const result = await scoreTone(request(), { fetch: successfulFetch(answer({ type: "score", score, confidence: 0 })) });
    expect(result).toEqual({ status: "scored", score });
  });

  it.each([
    null, {}, { answers: null }, { answers: {} }, answer(null),
    answer({ error: { type: "question_error" } }),
    answer({ type: "choice", choice: "kind" }), answer({ type: "score" }),
    answer({ type: "score", score: "1.5" }), answer({ type: "score", score: null }),
    answer({ type: "score", score: -0.01 }), answer({ type: "score", score: 4.01 }),
    { error: { message: "failed" }, answers: { tone: { type: "score", score: 3 } } },
  ])("returns unavailable for invalid response %#", async body => {
    expect(await scoreTone(request(), { fetch: successfulFetch(body) })).toEqual({ status: "unavailable", reason: "invalid-response" });
  });

  it.each(["1e400", "-1e400"])("rejects non-finite JSON number %s", async number => {
    const fetch = fakeFetch(async () => new Response(`{"answers":{"tone":{"type":"score","score":${number}}}}`));
    expect(await scoreTone(request(), { fetch })).toEqual({ status: "unavailable", reason: "invalid-response" });
  });

  it("returns unavailable on malformed JSON", async () => {
    const fetch = fakeFetch(async () => new Response("{broken", { status: 200 }));
    expect(await scoreTone(request(), { fetch })).toEqual({ status: "unavailable", reason: "invalid-response" });
  });

  it("returns unavailable on HTTP and transport errors without exposing upstream text", async () => {
    expect(await scoreTone(request(), { fetch: fakeFetch(async () => response({ error: "secret" }, 503)) }))
      .toEqual({ status: "unavailable", reason: "http" });
    expect(await scoreTone(request(), { fetch: fakeFetch(async () => { throw new Error("secret"); }) }))
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

    expect(await scoreTone(request(), { fetch })).toEqual({ status: "unavailable", reason: "http" });
    expect(outbound).toBeDefined();
    expect(outbound?.aborted || cancelBody.mock.calls.length > 0).toBe(true);
  }, 1000);

  it("does not start an already cancelled or expired operation", async () => {
    const fetch = vi.fn(fakeFetch(async () => response({})));
    const controller = new AbortController();
    controller.abort();
    expect(await scoreTone(request({ signal: controller.signal }), { fetch })).toEqual({ status: "unavailable", reason: "cancelled" });
    expect(await scoreTone(request({ deadline: Date.now() - 1 }), { fetch })).toEqual({ status: "unavailable", reason: "timeout" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts the request and settles on cancellation even if fetch ignores abort", async () => {
    const controller = new AbortController();
    let outbound: AbortSignal | null | undefined;
    const fetch = fakeFetch((_input, init) => { outbound = init?.signal; return new Promise(() => {}); });
    const pending = scoreTone(request({ signal: controller.signal }), { fetch });
    controller.abort();
    expect(await pending).toEqual({ status: "unavailable", reason: "cancelled" });
    expect(outbound?.aborted).toBe(true);
  });

  it("enforces the shared absolute deadline even if fetch ignores abort", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let outbound: AbortSignal | null | undefined;
    const fetch = fakeFetch((_input, init) => { outbound = init?.signal; return new Promise(() => {}); });
    const pending = scoreTone(request({ deadline: 1_250 }), { fetch });
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
    const pending = scoreTone(request({ deadline: 2_250 }), { fetch });
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toEqual({ status: "unavailable", reason: "timeout" });
    expect(outbound?.aborted).toBe(true);
  });
});
