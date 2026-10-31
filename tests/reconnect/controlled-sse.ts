import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client";
import { record } from "../native/support.js";

export const location = { directory: "/pn-term-1/owned-workspace" };
export type Termination = "eof" | "error";
export interface ControlledConnection {
  readonly openedAt: number;
  readonly ended: boolean;
  send(event: OpenCodeEvent): void;
  terminate(kind: Termination): void;
}
export interface Receipt {
  invocationID: string;
  displayed: boolean;
  directory: string | undefined;
}

/** Valid wire events for the real SDK decoder and production UUID validator. */
export function feedback(index: number) {
  return {
    type: "rpc.play-nice.feedback", id: `evt_pn_term_1_${index}`, created: 10000 + index,
    location,
    data: {
      invocationID: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      sessionID: "ses_pn_term_1", messageID: `msg_pn_term_1_${index}`,
      outcome: "blocked", message: `PN-TERM-1 owned notice ${index}`,
    },
  } as const satisfies OpenCodeEvent;
}

/** Controlled HTTP boundary, not a mocked SDK or replacement RPC iterator.
 * No socket, native executable, personal config or live service is used. */
export function controlledSse(autoTerminate: readonly Termination[] = []) {
  const origin = "http://pn-term-1.invalid";
  const connections: ControlledConnection[] = [];
  const receipts: Receipt[] = [];
  const encoder = new TextEncoder();
  let disposed = false;

  const fetch: typeof globalThis.fetch = async (resource, init) => {
    const request = new Request(resource, init);
    const url = new URL(request.url);
    if (disposed || url.origin !== origin) throw new Error("Unexpected PN-TERM-1 transport access");
    if (request.signal.aborted) throw new DOMException("Owned request cancelled", "AbortError");
    if (request.method === "GET" && url.pathname === "/api/event") {
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let ended = false;
      const abort = () => connection.terminate("error");
      const connection: ControlledConnection = {
        openedAt: Date.now(),
        get ended() { return ended; },
        send(event) {
          if (ended || !controller) throw new Error("Cannot send on an ended owned SSE stream");
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        },
        terminate(kind) {
          if (ended || !controller) return;
          ended = true;
          request.signal.removeEventListener("abort", abort);
          if (kind === "eof") controller.close();
          else controller.error(new Error("PN-TERM-1 controlled stream failure"));
        },
      };
      const body = new ReadableStream<Uint8Array>({
        start(value) { controller = value; },
        cancel() { ended = true; request.signal.removeEventListener("abort", abort); },
      });
      connections.push(connection);
      request.signal.addEventListener("abort", abort, { once: true });
      connection.send({ type: "server.connected", id: `evt_pn_connected_${connections.length}`, data: {} });
      // The final connection stays open, even for a zero-delay retry bug: the
      // test can then assert timing without starving the runner in microtasks.
      const termination = autoTerminate[connections.length - 1];
      if (termination) connection.terminate(termination);
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (request.method === "POST" && url.pathname === "/api/rpc/play-nice/receipt") {
      const body: unknown = await request.json();
      if (!record(body) || !record(body.input) || typeof body.input.invocationID !== "string" || typeof body.input.displayed !== "boolean") {
        throw new Error("Invalid production receipt in PN-TERM-1 transport");
      }
      receipts.push({
        invocationID: body.input.invocationID, displayed: body.input.displayed,
        directory: url.searchParams.get("location[directory]") ?? undefined,
      });
      return Response.json({ output: { accepted: true } });
    }
    throw new Error("Unexpected PN-TERM-1 endpoint");
  };
  return {
    origin, fetch, connections, receipts,
    current() {
      const connection = connections.at(-1);
      if (!connection || connection.ended) throw new Error("No active owned SSE connection");
      return connection;
    },
    dispose() { disposed = true; for (const connection of connections) connection.terminate("eof"); },
  };
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Emulate only the host's existing reconnecting consumer. It uses the SAME
 * actual SDK/shared stream as the plugin and never calls plugin setup again. */
export function reconnectingHost(client: OpenCodeClient) {
  const controller = new AbortController();
  const events: OpenCodeEvent[] = [];
  let connected = 0;
  let failures = 0;
  const completion = (async () => {
    while (!controller.signal.aborted) {
      try {
        for await (const event of client.event.subscribe({ signal: controller.signal })) {
          if (event.type === "server.connected") connected++;
          else events.push(event);
        }
      } catch {
        if (!controller.signal.aborted) failures++;
      }
      await abortableDelay(25, controller.signal); // Test-owned host policy, not the production retry policy.
    }
  })();
  return {
    events,
    get connected() { return connected; },
    get failures() { return failures; },
    stop() { controller.abort(); return completion; },
  };
}
