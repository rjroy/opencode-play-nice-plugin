import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SessionMessageInfo } from "@opencode/client";
import { expect, it } from "vitest";
import productionTui from "../../src/tui.js";
import { nativeFixture, type NativeFixture } from "./fixture.js";
import { feedbackTimeoutMs } from "./isolation.js";
import { rpcReceiptClient } from "./rpc-receipt-client.js";
import { nativeReceiptGate, recordingTuiContext, type RecordedToast } from "./production-tui.js";
import { bounded, pause } from "./support.js";

const identity = (prefix: "ses" | "msg") => `${prefix}_fixture_${randomBytes(12).toString("hex")}`;
async function session(fixture: NativeFixture) {
  return fixture.client.session.create({
    id: identity("ses"), title: "Play Nice owned admission fixture", location: fixture.location,
    model: { providerID: "fixture-provider", id: "fixture-model" },
    permissions: [{ action: "*", resource: "*", effect: "deny" }],
  }, fixture.options());
}
async function messages(fixture: NativeFixture, sessionID: string): Promise<SessionMessageInfo[]> {
  const all: SessionMessageInfo[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const value = await fixture.client.message.list({ sessionID, limit: 50, ...(cursor ? { cursor } : { order: "asc" as const }) }, fixture.options());
    all.push(...value.data);
    const next = value.cursor.next;
    if (!next || !value.data.length) return all;
    if (seen.has(next)) throw new Error("repeated native history cursor");
    seen.add(next); cursor = next;
  }
  throw new Error("unexpected fixture history size");
}
function prompt(fixture: NativeFixture, sessionID: string, id: string, text: string) {
  let settled = false;
  // No timeout abort is mistaken for a native rejection: inspect HTTP 500 below.
  const result = fixture.client.session.prompt({ sessionID, id, text }, fixture.options()).then(
    admission => { settled = true; return { kind: "admitted" as const, admission }; },
    error => { settled = true; return { kind: "rejected" as const, error }; },
  );
  fixture.ownFollower(async () => { await bounded(result, "owned prompt request cleanup", 3000); });
  return { result, settled: () => settled };
}
async function classifierEntered(fixture: NativeFixture, text: string, pending: ReturnType<typeof prompt>) {
  const first = await bounded(Promise.race([
    fixture.services.seen(text).then(() => "classifier-entered"),
    pending.result.then(value => value.kind === "admitted" ? "prompt admitted before classifier" : "prompt rejected before classifier"),
  ]), "controlled classifier entry");
  expect(first, "Missing native Play Nice prompt hook: admission must wait for our classifier").toBe("classifier-entered");
}
async function noAdmission(fixture: NativeFixture, sessionID: string, id: string, providerBaseline: number, peer?: Awaited<ReturnType<typeof rpcReceiptClient>>) {
  expect((await fixture.client.session.inbox.list({ sessionID }, fixture.options())).some(item => item.id === id), "blocked input is in durable inbox").toBe(false);
  expect((await messages(fixture, sessionID)).some(item => item.id === id), "blocked input is in canonical history").toBe(false);
  expect(fixture.services.providerAttempts, "provider dispatched while prompt was held/blocked").toBe(providerBaseline);
  if (peer) expect(peer.admissions.has(id), "blocked input emitted a durable admission event").toBe(false);
}
async function completed(fixture: NativeFixture, sessionID: string, messageID: string, text: string) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const history = await messages(fixture, sessionID);
    const user = history.find(item => item.id === messageID);
    const response = history.find(item => item.type === "assistant" && item.time.completed !== undefined && item.finish === "stop" && !item.error &&
      item.content.some(part => part.type === "text" && part.text === "fixture-model-ok"));
    const info = await fixture.client.session.get({ sessionID }, fixture.options());
    const active = await fixture.client.session.active(fixture.options());
    if (user?.type === "user" && user.text === text && response && info.outcome === "succeeded" && !active[sessionID]) return;
    await pause(30);
  }
  throw new Error("allowed prompt canonical completion timed out");
}

it("holds before admission/dispatch, awaits the invocation receipt, rejects, then accepts an edited prompt (RPC peer, not visible TUI proof)", async () => {
  const fixture = await nativeFixture();
  try {
    const peer = await rpcReceiptClient(fixture);
    // Positive control first: prove native/provider/package setup works even with
    // the intentionally no-op production skeleton. The expected RED is later.
    const control = await session(fixture);
    const controlID = identity("msg");
    await fixture.client.session.prompt({ sessionID: control.id, id: controlID, text: "fixture-allowed-control" }, fixture.options());
    await completed(fixture, control.id, controlID, "fixture-allowed-control");
    expect(fixture.services.providerAttempts).toBeGreaterThan(0);
    await fixture.recordReceipt({ allowedControlCompleted: true, phase: "blocked-behavior-attempt" });

    const target = await session(fixture);
    const blockedID = identity("msg");
    const text = "fixture-blocked-held";
    const baseline = fixture.services.providerAttempts;
    const pending = prompt(fixture, target.id, blockedID, text);
    await classifierEntered(fixture, text, pending);
    await pause(100); // Bounded quiet observation, NOT a readiness sleep.
    expect(pending.settled()).toBe(false);
    expect(peer.events.some(event => event.messageID === blockedID)).toBe(false);
    await noAdmission(fixture, target.id, blockedID, baseline, peer);

    fixture.services.release(text);
    const feedback = await bounded(Promise.race([
      peer.feedback(blockedID), peer.failure(),
      pending.result.then(() => { throw new Error("prompt settled before rejection feedback/receipt"); }),
    ]), "rejection feedback event");
    expect(feedback.sessionID).toBe(target.id);
    expect(feedback.outcome).toBe("blocked");
    expect(pending.settled()).toBe(false);
    // Receipt for a different invocation cannot unblock this prompt.
    expect(await peer.receipt("fixture-unknown-invocation", true)).toBe(false);
    await pause(100);
    expect(pending.settled()).toBe(false);
    await noAdmission(fixture, target.id, blockedID, baseline, peer);
    expect(await peer.receipt(feedback.invocationID, true)).toBe(true);
    const result = await bounded(pending.result, "native deliberate rejection");
    expect(result.kind).toBe("rejected");
    expect(fixture.statusFor(blockedID)).toBe(500); // Pinned native throw mapping, not a client abort.
    await pause(100);
    await noAdmission(fixture, target.id, blockedID, baseline, peer);
    expect(await peer.receipt(feedback.invocationID, true), "late receipt must not settle another prompt").toBe(false);
    await fixture.recordReceipt({ heldNoAdmission: true, heldNoDispatch: true, receiptBeforeRejection: true, rejectedNoAdmission: true, rejectedNoDispatch: true });

    const editedID = identity("msg");
    const edited = "fixture-allowed-edited";
    const admitted = await fixture.client.session.prompt({ sessionID: target.id, id: editedID, text: edited }, fixture.options());
    expect(admitted.id).toBe(editedID);
    expect(admitted.payload.text).toBe(edited);
    await completed(fixture, target.id, editedID, edited);
    expect(fixture.services.classificationCalls.filter(value => value === edited)).toHaveLength(1);
    expect(fixture.services.providerBodies.every(body => !body.includes(text))).toBe(true);
    expect(fixture.services.faults).toEqual([]);
    await fixture.recordReceipt({ status: "passed", editedCompleted: true, evidence: "server-rpc-peer-only-not-tui" });
  } finally { await fixture.close(); }
});

it.each(["negative-receipt", "receipt-timeout", "no-peer"] as const)("still blocks admission and dispatch after %s", async failure => {
  const fixture = await nativeFixture();
  try {
    const peer = failure === "no-peer" ? undefined : await rpcReceiptClient(fixture);
    const target = await session(fixture);
    const id = identity("msg");
    const text = `fixture-blocked-${failure}`;
    const baseline = fixture.services.providerAttempts;
    const pending = prompt(fixture, target.id, id, text);
    await classifierEntered(fixture, text, pending);
    await noAdmission(fixture, target.id, id, baseline, peer);
    const released = Date.now();
    fixture.services.release(text);
    if (peer) {
      const event = await bounded(Promise.race([peer.feedback(id), peer.failure(), pending.result.then(() => { throw new Error("blocked prompt settled before feedback"); })]), "failed feedback event");
      expect(event.outcome).toBe("blocked");
      expect(pending.settled()).toBe(false);
      if (failure === "negative-receipt") expect(await peer.receipt(event.invocationID, false)).toBe(true);
      else {
        await pause(100);
        expect(pending.settled(), "receipt timeout must await its bounded deadline").toBe(false);
      }
    }
    const result = await bounded(pending.result, "blocked feedback failure settlement", feedbackTimeoutMs + 3000);
    expect(result.kind).toBe("rejected");
    expect(fixture.statusFor(id)).toBe(500);
    expect(Date.now() - released).toBeLessThan(feedbackTimeoutMs + 3000);
    await pause(100);
    await noAdmission(fixture, target.id, id, baseline, peer);
    expect(fixture.services.faults).toEqual([]);
    await fixture.recordReceipt({ status: "passed", feedbackFailure: failure, rejectedNoAdmission: true, rejectedNoDispatch: true, evidence: "server-only-not-tui" });
  } finally { await fixture.close(); }
});

it.each(["explicit-location", "default-location"] as const)("production TUI handler invokes toast before its native receipt and rejection (%s; headless, not rendered)", async locationSource => {
  const fixture = await nativeFixture();
  try {
    const order: string[] = [];
    const gate = nativeReceiptGate(fixture, order);
    // This peer only observes. It cannot acknowledge even allowed events. Its
    // barrier uses the SAME pinned client/shared stream as the real handler.
    const observer = await rpcReceiptClient({ ...fixture, client: gate.client }, { acknowledgeAllowed: false });
    const toasts: RecordedToast[] = [];
    const foreignToasts: RecordedToast[] = [];
    const foreign = { directory: join(fixture.location.directory, "other-tui-location") };
    await mkdir(foreign.directory, { mode: 0o700 });
    // Start both production listeners before prompting. The foreign listener
    // must ignore the same real event, not merely ignore synthetic test data.
    fixture.ownFollower(productionTui.setup(recordingTuiContext({
      client: gate.client, location: foreign, defaultLocation: fixture.location,
      show: toast => { foreignToasts.push(toast); order.push("foreign-toast"); },
    })));
    fixture.ownFollower(productionTui.setup(recordingTuiContext({
      client: gate.client, location: locationSource === "explicit-location" ? fixture.location : undefined,
      defaultLocation: fixture.location,
      show: toast => { toasts.push(toast); order.push("matching-toast"); },
    })));

    const target = await session(fixture);
    const id = identity("msg");
    const text = `fixture-blocked-production-tui-${locationSource}`;
    const baseline = fixture.services.providerAttempts;
    const pending = prompt(fixture, target.id, id, text);
    void pending.result.then(result => { order.push(result.kind === "rejected" ? "prompt-rejected" : "prompt-admitted"); });
    await classifierEntered(fixture, text, pending);
    expect(toasts).toEqual([]);
    await noAdmission(fixture, target.id, id, baseline, observer);
    fixture.services.release(text);

    const feedback = await bounded(Promise.race([
      observer.feedback(id), observer.failure(),
      pending.result.then(() => { throw new Error("Prompt settled before production TUI feedback was observed"); }),
    ]), "production TUI native event", feedbackTimeoutMs + 1000);
    const receipt = await bounded(Promise.race([
      gate.started, observer.failure(),
      pending.result.then(() => { throw new Error("Production TUI did not invoke toast and request its receipt before rejection"); }),
    ]), "production TUI receipt attempt", feedbackTimeoutMs + 1000);
    expect(feedback.sessionID).toBe(target.id);
    expect(feedback.outcome).toBe("blocked");
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ sessionID: target.id, message: feedback.message });
    expect(foreignToasts).toEqual([]);
    expect(receipt).toEqual({ invocationID: feedback.invocationID, displayed: true, directory: fixture.location.directory });
    expect(gate.requests).toHaveLength(1);
    expect(order).toEqual(["matching-toast", "receipt-attempt"]);
    await pause(100); // Observe the prompt while its REAL receipt HTTP is held.
    expect(pending.settled()).toBe(false);
    await noAdmission(fixture, target.id, id, baseline, observer);

    gate.release();
    const [result, reply] = await bounded(Promise.all([pending.result, gate.replied]), "native production TUI receipt and rejection");
    expect(reply).toEqual({ status: 200, accepted: true });
    expect(result.kind).toBe("rejected");
    expect(fixture.statusFor(id)).toBe(500);
    // Independent HTTP responses may complete out of order. The causal proof
    // is toast -> held receipt attempt -> actual dispatch -> prompt rejection,
    // plus the native server's accepted:true for that exact invocation.
    expect(order).toEqual(["matching-toast", "receipt-attempt", "receipt-dispatched", "prompt-rejected"]);
    await pause(100);
    await noAdmission(fixture, target.id, id, baseline, observer);
    expect(gate.requests).toHaveLength(1);
    expect(foreignToasts).toEqual([]);
    expect(fixture.services.faults).toEqual([]);
    await fixture.recordReceipt({ status: "passed", evidence: "production-tui-handler-recording-toast-not-rendered", handlerLocationSource: locationSource,
      toastBeforeReceipt: true, receiptBeforeRejection: true, foreignLocationIgnored: true, rejectedNoAdmission: true, rejectedNoDispatch: true });
  } finally { await fixture.close(); }
});
