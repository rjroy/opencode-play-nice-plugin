import { feedbackRpc } from "../../src/rpc.js";
import type { NativeFixture } from "./fixture.js";
import { bounded, deferred, record } from "./support.js";

export interface Feedback {
  invocationID: string;
  sessionID: string;
  messageID: string;
  outcome: "allowed" | "blocked";
  message: string;
}
function parseFeedback(value: unknown): Feedback {
  if (!record(value) || typeof value.invocationID !== "string" || typeof value.sessionID !== "string" ||
      typeof value.messageID !== "string" || typeof value.message !== "string" || !value.message ||
      (value.outcome !== "allowed" && value.outcome !== "blocked")) throw new Error("invalid feedback event");
  return { invocationID: value.invocationID, sessionID: value.sessionID, messageID: value.messageID, outcome: value.outcome, message: value.message };
}

/** A server-only RPC peer, NOT a TUI, toast implementation or rendering witness. */
export async function rpcReceiptClient(fixture: NativeFixture, options: { acknowledgeAllowed?: boolean } = {}) {
  const controller = new AbortController();
  const connected = deferred<void>();
  const waiting = new Map<string, ReturnType<typeof deferred<Feedback>>>();
  const events: Feedback[] = [];
  const admissions = new Set<string>();
  const rpc = fixture.client.rpc(feedbackRpc);
  const receipt = async (invocationID: string, displayed: boolean) => {
    const value = await rpc.receipt({ invocationID, displayed }, { location: fixture.location, ...fixture.options() });
    if (!record(value) || typeof value.accepted !== "boolean") throw new Error("invalid receipt result");
    return value.accepted;
  };
  const forMessage = (id: string) => {
    let value = waiting.get(id);
    if (!value) { value = deferred<Feedback>(); waiting.set(id, value); }
    return value;
  };
  // One stream owns both the server.connected readiness barrier and event reads.
  // Opening a second independent filtered iterator after prompting would race.
  const completion = (async () => {
    for await (const event of fixture.client.event.subscribe({ types: ["rpc.play-nice.feedback", "session.inbox.enqueued", "session.inbox.delivered"], signal: controller.signal })) {
      if (event.type === "server.connected") { connected.resolve(); continue; }
      if (event.location?.directory !== fixture.location.directory) continue;
      if (event.type === "session.inbox.enqueued" || event.type === "session.inbox.delivered") {
        admissions.add(event.data.inboxID); continue;
      }
      if (event.type !== "rpc.play-nice.feedback") continue;
      const feedback = parseFeedback(event.data);
      events.push(feedback);
      forMessage(feedback.messageID).resolve(feedback);
      // Explicit test-peer acknowledgement only. This never calls ui.toast.show.
      // Blocked events are always held for the test to release or fail.
      if (options.acknowledgeAllowed !== false && feedback.outcome === "allowed") await receipt(feedback.invocationID, true);
    }
    if (!controller.signal.aborted) throw new Error("RPC event stream ended unexpectedly");
  })().then(() => ({ kind: "complete" as const }), error => ({ kind: "error" as const, error }));
  const stop = async () => {
    controller.abort();
    const outcome = await bounded(completion, "RPC receipt peer cleanup", 3000);
    // SharedEvents normally completes on its own abort; preserve every failure.
    if (outcome.kind === "error") throw outcome.error;
  };
  fixture.ownFollower(stop);
  await bounded(Promise.race([connected.promise, completion.then(() => { throw new Error("RPC stream failed before readiness"); })]), "RPC stream readiness");
  return { events, admissions, receipt, feedback: (messageID: string) => forMessage(messageID).promise,
    failure: () => completion.then(outcome => { throw outcome.kind === "error" ? outcome.error : new Error("RPC peer stopped"); }) };
}
