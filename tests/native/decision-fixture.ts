import type { ServerResponse } from "node:http";
import { deferred, record } from "./support.js";

/** Test-owned replies: never ask a live model to choose test results. */
export type DecisionReply = { kind: "score"; score: number } | { kind: "http-error" } | { kind: "malformed" } | { kind: "timeout" };

export function decisionFixture(faults: string[]) {
  const requests: Record<string, unknown>[] = [];
  const aborted = new Set<string>();
  const scripts = new Map<string, { reply: DecisionReply; hold: boolean }>();
  const waiting = new Map<string, ReturnType<typeof deferred<void>>>();
  const held = new Map<string, { response: ServerResponse; reply: DecisionReply }>();
  const seen = (state: string) => {
    let entry = waiting.get(state);
    if (!entry) { entry = deferred<void>(); waiting.set(state, entry); }
    return entry;
  };
  const respond = (response: ServerResponse, reply: DecisionReply) => {
    if (reply.kind === "timeout") return; // Native must cancel its own HTTP operation.
    response.writeHead(reply.kind === "http-error" ? 503 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify(reply.kind === "score" ? { answers: { tone: { type: "score", score: reply.score } } }
      : reply.kind === "http-error" ? { error: "owned Decision HTTP failure" }
      : { answers: { tone: { type: "score", score: "not-a-number" } } }));
  };
  return {
    requests, aborted,
    plan(state: string, reply: DecisionReply, hold = false) { scripts.set(state, { reply, hold }); },
    seen: (state: string) => seen(state).promise,
    handle(value: Record<string, unknown>, response: ServerResponse) {
      requests.push(value);
      if (typeof value.model !== "string" || typeof value.state !== "string" || !record(value.questions)) {
        faults.push("invalid-decision-input"); response.writeHead(400).end(); return;
      }
      const state = value.state;
      const script = scripts.get(state);
      if (!script) { faults.push("unscripted-decision"); response.writeHead(400).end(); return; }
      response.once("close", () => {
        if (!response.writableEnded) aborted.add(state);
        if (held.get(state)?.response === response) held.delete(state);
      });
      if (script.hold || script.reply.kind === "timeout") held.set(state, { response, reply: script.reply });
      if (!script.hold) respond(response, script.reply);
      seen(state).resolve();
    },
    release(state: string) {
      const entry = held.get(state);
      if (!entry) throw new Error("No owned Decision response is held");
      if (entry.reply.kind !== "timeout") held.delete(state);
      respond(entry.response, entry.reply);
    },
    close() { for (const entry of held.values()) entry.response.destroy(); held.clear(); },
  };
}
