import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { forbiddenPorts } from "./isolation.js";
import { bounded, deferred, record } from "./support.js";
import { decisionFixture } from "./decision-fixture.js";

/** No tools or outbound connections; records every provider attempt, even invalid ones. */
export function fakeServices() {
  const providerBodies: string[] = [];
  const faults: string[] = [];
  const decision = decisionFixture(faults);
  const seen = new Map<string, ReturnType<typeof deferred<void>>>();
  const held = new Map<string, ServerResponse>();
  const classificationCalls: string[] = [];
  let providerAttempts = 0;
  let holdNextProvider = false;
  let heldProvider: (() => void) | undefined;
  const providerHeld = deferred<void>();
  const classified = (text: string) => {
    let entry = seen.get(text);
    if (!entry) { entry = deferred<void>(); seen.set(text, entry); }
    return entry;
  };
  const server = createServer((request, response) => {
    const provider = request.url === "/v1/chat/completions";
    if (provider) providerAttempts++;
    const decisionRequest = request.url === "/v1/systemone";
    if (request.method !== "POST" || (!provider && request.url !== "/classify" && !decisionRequest)) {
      faults.push("unexpected-route"); response.writeHead(404).end(); return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body) > 1_000_000) { faults.push("body-limit"); request.destroy(); }
    });
    request.on("error", () => { if (!request.aborted) faults.push("request-error"); });
    request.on("end", () => {
      let value: unknown;
      try { value = JSON.parse(body); } catch { faults.push("invalid-json"); response.writeHead(400).end(); return; }
      if (!record(value)) { faults.push("invalid-shape"); response.writeHead(400).end(); return; }
      if (decisionRequest) { decision.handle(value, response); return; }
      if (!provider) {
        if (typeof value.text !== "string") { faults.push("invalid-classifier-input"); response.writeHead(400).end(); return; }
        classificationCalls.push(value.text);
        if (value.text.startsWith("fixture-blocked-")) held.set(value.text, response);
        else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ outcome: "allowed" }));
        classified(value.text).resolve();
        return;
      }
      providerBodies.push(body);
      if (value.model !== "fixture-model" || !Array.isArray(value.messages)) {
        faults.push("invalid-provider-input"); response.writeHead(400).end(); return;
      }
      const streaming = value.stream === true;
      const respond = () => {
        const content = "fixture-model-ok";
        if (streaming) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          const frame = (delta: object, finish: string | null) => response.write(`data: ${JSON.stringify({
            id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model",
            choices: [{ index: 0, delta, finish_reason: finish }],
            ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
          })}\n\n`);
          frame({ content }, null); frame({}, "stop"); response.end("data: [DONE]\n\n");
        } else {
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
            id: "fixture", object: "chat.completion", created: 1, model: "fixture-model",
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }));
        }
      };
      if (holdNextProvider) {
        holdNextProvider = false;
        heldProvider = respond;
        providerHeld.resolve();
      } else respond();
    });
  });
  return {
    providerBodies, faults, classificationCalls, decision,
    get providerAttempts() { return providerAttempts; },
    holdNextProvider() { holdNextProvider = true; },
    providerHeld: () => providerHeld.promise,
    releaseProvider() {
      if (!heldProvider) throw new Error("no held provider response");
      const respond = heldProvider; heldProvider = undefined; respond();
    },
    seen: (text: string) => classified(text).promise,
    release(text: string) {
      const response = held.get(text);
      if (!response) throw new Error("no held classification request");
      held.delete(text);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ outcome: "blocked" }));
    },
    async start() {
      const listening = once(server, "listening");
      server.listen(0, "127.0.0.1");
      await bounded(listening, "fake service startup");
      const address = server.address();
      if (!address || typeof address === "string" || address.address !== "127.0.0.1" || forbiddenPorts.has(address.port)) throw new Error("invalid fake service bind");
      return `http://127.0.0.1:${address.port}`;
    },
    async close() {
      decision.close();
      for (const response of held.values()) response.destroy();
      held.clear();
      if (!server.listening) return;
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await bounded(closed, "fake service cleanup", 3000);
    },
  };
}
