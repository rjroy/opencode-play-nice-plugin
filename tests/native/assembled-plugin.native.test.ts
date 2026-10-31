import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
// Resolve the ACTUAL package export, not the boundary fixture adapter.
import productionTui from "opencode-play-nice-plugin/tui";
import { nativeFixture, type NativeFixture } from "./fixture.js";
import type { DecisionReply, FixtureTone } from "./decision-fixture.js";
import { nativeReceiptGate, recordingTuiContext, type RecordedToast } from "./production-tui.js";
import { rpcReceiptClient } from "./rpc-receipt-client.js";
import { completed, identity, messages, noAdmission, prompt, session } from "./session.js";
import { bounded, pause, record } from "./support.js";

const labels: readonly FixtureTone[] = ["kind", "neutral", "frustrated", "rude", "abusive"];

async function headless(fixture: NativeFixture, heldReceipt = false, failedToast = false) {
  const order: string[] = [];
  const gate = nativeReceiptGate(fixture, order);
  const observer = await rpcReceiptClient({ ...fixture, client: gate.client }, { acknowledgeAllowed: false });
  const toasts: RecordedToast[] = [];
  fixture.ownFollower(productionTui.setup(recordingTuiContext({
    client: gate.client, location: fixture.location, defaultLocation: fixture.location,
    show: toast => {
      toasts.push(toast); order.push("toast-attempt");
      if (failedToast) throw new Error("Owned toast invocation failure");
    },
  })));
  if (!heldReceipt) gate.release();
  // The native package copy must preserve the production default exports.
  const installed: unknown = JSON.parse(await readFile(join(fixture.pluginPackage, "package.json"), "utf8"));
  const actual: unknown = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  expect(installed).toEqual(actual);
  expect(installed).toMatchObject({ exports: { "./server": "./src/server.ts", "./tui": "./src/tui.ts", "./rpc": "./src/rpc.ts" } });
  const plugins = await fixture.client.plugin.list({ location: fixture.location }, fixture.options());
  expect(plugins.data.find(plugin => plugin.id === "play-nice")).toMatchObject({ state: { status: "active" }, features: { server: true, tui: true, rpc: true } });
  return { order, gate, observer, toasts };
}
type Headless = Awaited<ReturnType<typeof headless>>;

function start(fixture: NativeFixture, ui: Headless, sessionID: string, text: string, reply: DecisionReply, hold = false) {
  ui.order.length = 0;
  fixture.services.decision.plan(text, reply, hold);
  const id = identity("msg");
  const baseline = fixture.services.providerAttempts;
  const toastOffset = ui.toasts.length;
  const started = Date.now();
  const pending = prompt(fixture, sessionID, id, text);
  void pending.result.then(result => { ui.order.push(result.kind === "admitted" ? "prompt-admitted" : "prompt-rejected"); });
  return { id, text, baseline, toastOffset, started, pending, sessionID };
}
type Turn = ReturnType<typeof start>;

async function feedback(ui: Headless, turn: Turn) {
  return bounded(Promise.race([
    ui.observer.feedback(turn.id), ui.observer.failure(),
  ]), "assembled production feedback", 5000);
}

function currentMessageRequest(fixture: NativeFixture, text: string) {
  const matching = fixture.services.decision.requests.filter(request => request.state === text);
  expect(matching).toHaveLength(1);
  const request = matching[0];
  if (!request || !record(request.questions) || !record(request.questions.tone)) throw new Error("Missing owned choice request");
  expect(Object.keys(request).sort()).toEqual(["model", "questions", "state"]);
  expect(request.model).toBe("d3"); // Default model, but ONLY sent to the fake endpoint.
  expect(request.state).toBe(text);
  expect(Object.keys(request.questions)).toEqual(["tone"]);
  expect(request.questions.tone.type).toBe("choice");
  expect(typeof request.questions.tone.instructions).toBe("string");
  expect(String(request.questions.tone.instructions).length).toBeGreaterThan(0);
  if (!record(request.questions.tone.criteria)) throw new Error("Missing choice criteria");
  expect(Object.keys(request.questions.tone.criteria).sort()).toEqual([...labels].sort());
  expect(Object.values(request.questions.tone.criteria).every(value => typeof value === "string" && value.length > 0)).toBe(true);
  expect(fixture.services.classificationCalls).toEqual([]); // Never the injected /classify adapter.
}

async function finish(fixture: NativeFixture, ui: Headless, turn: Turn, report: FixtureTone | "unavailable", outcome: "allowed" | "blocked", toastSucceeded = true) {
  const event = await feedback(ui, turn);
  const [result, reply] = await bounded(Promise.all([turn.pending.result, ui.gate.replyFor(event.invocationID)]), "assembled receipt and prompt settlement");
  expect(event.sessionID).toBe(turn.sessionID);
  expect(event.outcome).toBe(outcome);
  expect(event.message.toLowerCase()).toContain(report);
  expect(ui.toasts.slice(turn.toastOffset)).toHaveLength(1);
  expect(ui.toasts[turn.toastOffset]).toMatchObject({ sessionID: turn.sessionID, message: event.message });
  expect(ui.gate.requests.filter(request => request.invocationID === event.invocationID)).toEqual([
    { invocationID: event.invocationID, displayed: toastSucceeded, directory: fixture.location.directory },
  ]);
  expect(reply).toEqual({ status: 200, accepted: true });
  expect(ui.order).toEqual(["toast-attempt", "receipt-attempt", "receipt-dispatched", outcome === "allowed" ? "prompt-admitted" : "prompt-rejected"]);
  currentMessageRequest(fixture, turn.text);
  if (outcome === "allowed") {
    if (result.kind !== "admitted") throw new Error("Assembled allowed/unavailable prompt was not admitted");
    expect(result.admission.id).toBe(turn.id);
    expect(result.admission.payload.text).toBe(turn.text);
    await completed(fixture, turn.sessionID, turn.id, turn.text);
    expect(fixture.services.providerAttempts).toBeGreaterThan(turn.baseline);
    expect(fixture.services.providerBodies.some(body => body.includes(turn.text))).toBe(true);
  } else {
    expect(result.kind).toBe("rejected");
    expect(fixture.statusFor(turn.id)).toBe(500); // Not a client-side cancellation.
    await pause(75);
    await noAdmission(fixture, turn.sessionID, turn.id, turn.baseline, ui.observer);
    expect(fixture.services.providerBodies.every(body => !body.includes(turn.text))).toBe(true);
  }
  expect(fixture.services.faults).toEqual([]);
  return event;
}

it("assembled default package reports all five choices, allows rude by default, and sends only the current message", async () => {
  const fixture = await nativeFixture("assembled-default");
  try {
    const ui = await headless(fixture);
    const target = await session(fixture);
    const texts: string[] = [];
    for (const tone of labels) {
      const text = `assembled-current-${tone}`;
      texts.push(text);
      const turn = start(fixture, ui, target.id, text, { kind: "choice", tone });
      await finish(fixture, ui, turn, tone, "allowed");
    }
    expect(fixture.services.decision.requests.map(request => request.state)).toEqual(texts);
    expect((await messages(fixture, target.id)).filter(message => message.type === "user").map(message => message.text)).toEqual(texts);
    await fixture.recordReceipt({ status: "passed", allFiveReported: true, defaultRudeAllowed: true, currentMessageOnly: true, evidence: "assembled-default-package-headless-tui-not-rendered" });
  } finally { await fixture.close(); }
});

it("assembled opt-in blocks rude and abusive after toast receipt, then accepts an edited submission and an idempotent retry", async () => {
  const fixture = await nativeFixture("assembled-reject");
  try {
    const ui = await headless(fixture, true);
    const target = await session(fixture);
    const rude = start(fixture, ui, target.id, "assembled-held-rude", { kind: "choice", tone: "rude" }, true);
    await bounded(fixture.services.decision.seen(rude.text), "real Decision request");
    expect(rude.pending.settled()).toBe(false);
    expect(ui.toasts).toEqual([]);
    await noAdmission(fixture, target.id, rude.id, rude.baseline, ui.observer);
    fixture.services.decision.release(rude.text);
    const event = await feedback(ui, rude);
    const receipt = await bounded(ui.gate.started, "production rejection receipt attempt");
    expect(receipt).toEqual({ invocationID: event.invocationID, displayed: true, directory: fixture.location.directory });
    await pause(75);
    expect(rude.pending.settled()).toBe(false);
    await noAdmission(fixture, target.id, rude.id, rude.baseline, ui.observer);
    ui.gate.release();
    await finish(fixture, ui, rude, "rude", "blocked");
    const abusive = start(fixture, ui, target.id, "assembled-abusive", { kind: "choice", tone: "abusive" });
    await finish(fixture, ui, abusive, "abusive", "blocked");
    const edited = start(fixture, ui, target.id, "assembled-edited-neutral", { kind: "choice", tone: "neutral" });
    await finish(fixture, ui, edited, "neutral", "allowed");
    const requests = fixture.services.decision.requests.length;
    const dispatches = fixture.services.providerAttempts;
    const retry = await fixture.client.session.prompt({ sessionID: target.id, id: edited.id, text: edited.text }, fixture.options());
    expect(retry.id).toBe(edited.id);
    expect(retry.payload.text).toBe(edited.text);
    await pause(75);
    expect(fixture.services.decision.requests).toHaveLength(requests);
    expect(fixture.services.providerAttempts).toBe(dispatches);
    await fixture.recordReceipt({ status: "passed", rudeBlocked: true, abusiveBlocked: true, toastBeforeReceipt: true, receiptBeforeRejection: true, editedCompleted: true, retryDidNotRedispatch: true });
  } finally { await fixture.close(); }
});

it("assembled rejectedCategories override replaces rude/abusive defaults", async () => {
  const fixture = await nativeFixture("assembled-override");
  try {
    const ui = await headless(fixture);
    const target = await session(fixture);
    for (const tone of ["frustrated", "rude", "abusive"] as const) {
      const turn = start(fixture, ui, target.id, `assembled-override-${tone}`, { kind: "choice", tone });
      await finish(fixture, ui, turn, tone, tone === "frustrated" ? "blocked" : "allowed");
    }
    await fixture.recordReceipt({ status: "passed", categoryOverrideVerified: true });
  } finally { await fixture.close(); }
});

it("assembled HTTP, malformed and timeout classification failures allow with unavailable feedback and provider completion", async () => {
  const fixture = await nativeFixture("assembled-reject");
  try {
    const ui = await headless(fixture);
    const target = await session(fixture);
    for (const kind of ["http-error", "malformed", "timeout"] as const) {
      const turn = start(fixture, ui, target.id, `assembled-unavailable-${kind}`, { kind });
      await finish(fixture, ui, turn, "unavailable", "allowed");
      if (kind === "timeout") {
        const deadline = Date.now() + 2000;
        while (!fixture.services.decision.aborted.has(turn.text) && Date.now() < deadline) await pause(20);
        expect(fixture.services.decision.aborted.has(turn.text), "native classifier must abort its held HTTP request").toBe(true);
        expect(Date.now() - turn.started).toBeLessThan(4000); // Owned 2 s budget + integration allowance.
      }
    }
    await fixture.recordReceipt({ status: "passed", httpFailOpen: true, malformedFailOpen: true, timeoutFailOpen: true, decisionRequestAborted: true });
  } finally { await fixture.close(); }
});

it("assembled blocked decision remains blocked when the production toast invocation throws", async () => {
  const fixture = await nativeFixture("assembled-reject");
  try {
    const ui = await headless(fixture, true, true);
    const target = await session(fixture);
    const turn = start(fixture, ui, target.id, "assembled-failed-toast-abusive", { kind: "choice", tone: "abusive" });
    const event = await feedback(ui, turn);
    expect(await bounded(ui.gate.started, "failed toast negative receipt")).toEqual({ invocationID: event.invocationID, displayed: false, directory: fixture.location.directory });
    expect(turn.pending.settled()).toBe(false);
    await noAdmission(fixture, target.id, turn.id, turn.baseline, ui.observer);
    ui.gate.release();
    await finish(fixture, ui, turn, "abusive", "blocked", false);
    await fixture.recordReceipt({ status: "passed", failedToastStillBlocked: true, negativeReceiptFromProductionHandler: true });
  } finally { await fixture.close(); }
});

it("assembled concurrent prompt IDs retain separate production feedback receipts", async () => {
  const fixture = await nativeFixture("assembled-reject");
  try {
    const ui = await headless(fixture, true);
    const first = await session(fixture);
    const second = await session(fixture);
    const turns = [
      start(fixture, ui, first.id, "assembled-concurrent-rude", { kind: "choice", tone: "rude" }),
      start(fixture, ui, second.id, "assembled-concurrent-abusive", { kind: "choice", tone: "abusive" }),
    ];
    const events = await Promise.all(turns.map(turn => feedback(ui, turn)));
    const deadline = Date.now() + 1000;
    while (ui.gate.requests.length < 2 && Date.now() < deadline) await pause(10);
    expect(new Set(events.map(event => event.invocationID)).size).toBe(2);
    expect(ui.toasts).toHaveLength(2);
    expect(ui.gate.requests.map(request => request.invocationID).sort()).toEqual(events.map(event => event.invocationID).sort());
    for (const [index, turn] of turns.entries()) {
      expect(events[index]).toMatchObject({ sessionID: turn.sessionID, messageID: turn.id, outcome: "blocked" });
      expect(turn.pending.settled()).toBe(false);
      await noAdmission(fixture, turn.sessionID, turn.id, turn.baseline, ui.observer);
    }
    ui.gate.release();
    for (const [index, turn] of turns.entries()) {
      const event = events[index];
      if (!event) throw new Error("Missing concurrent feedback");
      expect(await bounded(ui.gate.replyFor(event.invocationID), "concurrent native receipt")).toEqual({ status: 200, accepted: true });
      expect((await bounded(turn.pending.result, "concurrent native rejection")).kind).toBe("rejected");
      expect(fixture.statusFor(turn.id)).toBe(500);
      currentMessageRequest(fixture, turn.text);
      await noAdmission(fixture, turn.sessionID, turn.id, turn.baseline, ui.observer);
    }
    expect(fixture.services.faults).toEqual([]);
    await fixture.recordReceipt({ status: "passed", concurrentReceiptsCorrelated: true, rejectedNoAdmission: true, rejectedNoDispatch: true });
  } finally { await fixture.close(); }
});
