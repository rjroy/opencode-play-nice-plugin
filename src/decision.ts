import { toneCriteria, toneInstructions } from "./tone.js";

export type ClassificationResult =
  | { status: "scored"; score: number }
  | { status: "unavailable"; reason: "http" | "transport" | "timeout" | "cancelled" | "invalid-response" };

export interface ClassificationRequest {
  text: string;
  endpoint?: string;
  model?: string;
  /** Absolute Unix milliseconds; shared with the caller's remaining operation. */
  deadline: number;
  signal?: AbortSignal;
}

export interface ClassificationDependencies {
  fetch: typeof fetch;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAnswer(value: unknown): ClassificationResult {
  if (!record(value) || "error" in value || !record(value.answers) || !record(value.answers.tone)) {
    return { status: "unavailable", reason: "invalid-response" };
  }
  const answer = value.answers.tone;
  if ("error" in answer || answer.type !== "score" || typeof answer.score !== "number" ||
      !Number.isFinite(answer.score) || answer.score < 0 || answer.score > 4) {
    return { status: "unavailable", reason: "invalid-response" };
  }
  return { status: "scored", score: answer.score };
}

/** Score only this message, bounded by the caller's absolute deadline. */
export async function classifyTone(
  request: ClassificationRequest,
  dependencies: ClassificationDependencies,
): Promise<ClassificationResult> {
  if (request.signal?.aborted) return { status: "unavailable", reason: "cancelled" };
  const remaining = request.deadline - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return { status: "unavailable", reason: "timeout" };

  const controller = new AbortController();
  let interrupt: (reason: "timeout" | "cancelled") => void = () => {};
  const interrupted = new Promise<ClassificationResult>(resolve => {
    interrupt = reason => {
      controller.abort();
      resolve({ status: "unavailable", reason });
    };
  });
  const cancel = () => interrupt("cancelled");
  request.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => interrupt("timeout"), remaining);

  const work = async (): Promise<ClassificationResult> => {
    let response: Response;
    try {
      response = await dependencies.fetch(request.endpoint ?? "http://localhost:11434/v1/systemone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: request.model ?? "d3",
          state: request.text,
          questions: { tone: { type: "score", instructions: toneInstructions, criteria: toneCriteria } },
        }),
        signal: controller.signal,
      });
    } catch {
      return { status: "unavailable", reason: "transport" };
    }
    if (controller.signal.aborted) {
      // A non-cooperative injected transport can resolve after cancellation.
      // Do not consume its response or leave its body open.
      void response.body?.cancel().catch(() => {});
      return { status: "unavailable", reason: "cancelled" };
    }
    if (!response.ok) {
      // The error body may never finish. Abort the owned fetch rather than
      // waiting for a drain after the operation's deadline is cleared.
      controller.abort();
      return { status: "unavailable", reason: "http" };
    }
    try {
      return parseAnswer(await response.json());
    } catch {
      return { status: "unavailable", reason: "invalid-response" };
    }
  };

  try {
    return await Promise.race([work(), interrupted]);
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", cancel);
  }
}
