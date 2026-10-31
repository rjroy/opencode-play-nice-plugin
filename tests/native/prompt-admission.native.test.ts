import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import productionTui from "../../src/tui.js";
import { nativeFixture, type NativeFixture } from "./fixture.js";
import { feedbackTimeoutMs } from "./isolation.js";
import { rpcReceiptClient } from "./rpc-receipt-client.js";
import { nativeReceiptGate, recordingTuiContext, type RecordedToast } from "./production-tui.js";
import { bounded, pause } from "./support.js";
import { completed, identity, noAdmission, prompt, session } from "./session.js";

async function classifierEntered(fixture: NativeFixture, text: string, pending: ReturnType<typeof prompt>) {
  const first = await bounded(Promise.race([
    fixture.services.seen(text).then(() => "classifier-entered"),
    pending.result.then(value => value.kind === "admitted" ? "prompt admitted before classifier" : "prompt rejected before classifier"),
  ]), "controlled classifier entry");
  expect(first, "Missing native Play Nice prompt hook: admission must wait for our classifier").toBe("classifier-entered");
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
