import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
// Resolve the ACTUAL package export, not the boundary fixture adapter.
import productionTui from "opencode-play-nice-plugin/tui";
import { nativeFixture, type NativeFixture } from "./fixture.js";
import type { DecisionReply } from "./decision-fixture.js";
import { nativeReceiptGate, recordingTuiContext, type RecordedToast } from "./production-tui.js";
import { rpcReceiptClient } from "./rpc-receipt-client.js";
import { completed, identity, messages, noAdmission, prompt, session } from "./session.js";
import { bounded, pause, record } from "./support.js";

const scores = [0, 1, 2, 3, 4] as const;
const levels = [/abus|threat|harass/i, /rude|disrespect|insult/i, /frustrat|dissatisf/i, /neutral|matter.of.fact/i, /kind|friendly|support|appreciat/i] as const;

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
  if (!request || !record(request.questions) || !record(request.questions.tone)) throw new Error("Missing owned score request");
  expect(Object.keys(request).sort()).toEqual(["model", "questions", "state"]);
  expect(request.model).toBe("d3"); // Default model, but ONLY sent to the fake endpoint.
  expect(request.state).toBe(text);
  expect(Object.keys(request.questions)).toEqual(["tone"]);
  expect(request.questions.tone.type).toBe("score");
  expect(typeof request.questions.tone.instructions).toBe("string");
  expect(String(request.questions.tone.instructions).length).toBeGreaterThan(0);
  expect(request.questions.tone).not.toHaveProperty("levels");
  const criteria = request.questions.tone.criteria;
  expect(Array.isArray(criteria)).toBe(true);
  if (!Array.isArray(criteria)) throw new Error("Missing score criteria");
  expect(criteria).toHaveLength(5);
  for (const [index, level] of levels.entries()) {
    expect(criteria[index]).toEqual(expect.any(String));
    expect(criteria[index]).toMatch(level);
  }
  expect(fixture.services.classificationCalls).toEqual([]); // Never the injected /classify adapter.
}

async function finish(fixture: NativeFixture, ui: Headless, turn: Turn, report: number | "unavailable", outcome: "allowed" | "blocked", toastSucceeded = true) {
  const event = await feedback(ui, turn);
  const [result, reply] = await bounded(Promise.all([turn.pending.result, ui.gate.replyFor(event.invocationID)]), "assembled receipt and prompt settlement");
  expect(event.sessionID).toBe(turn.sessionID);
  expect(event.outcome).toBe(outcome);
  expect(event.message.toLowerCase()).toContain(String(report));
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

it("assembled default package reports all five scores, allows low scores by default, and sends only the current message", async () => {
  const fixture = await nativeFixture("assembled-default");
  try {
    const ui = await headless(fixture);
    const target = await session(fixture);
    const texts: string[] = [];
    for (const score of scores) {
      const text = `assembled-current-${score}`;
      texts.push(text);
      const turn = start(fixture, ui, target.id, text, { kind: "score", score });
      await finish(fixture, ui, turn, score, "allowed");
    }
    expect(fixture.services.decision.requests.map(request => request.state)).toEqual(texts);
    expect((await messages(fixture, target.id)).filter(message => message.type === "user").map(message => message.text)).toEqual(texts);
    await fixture.recordReceipt({ status: "passed", allFiveReported: true, defaultRudeAllowed: true, currentMessageOnly: true, evidence: "assembled-default-package-headless-tui-not-rendered" });
  } finally { await fixture.close(); }
});

it("assembled play-nice command reflects recorded turns with optional question without rescoring", async () => {
  const fixture = await nativeFixture("assembled-default");
  try {
    const ui = await headless(fixture);
    const target = await session(fixture);
    const text = "reflection-evidence-please-fix-this-now";
    await finish(fixture, ui, start(fixture, ui, target.id, text, { kind: "score", score: 2.5 }), 2.5, "allowed");

    // Reload the owned native location rather than reconstructing plugin state
    // in the test; the subsequent task must use the persisted evaluation.
    await fixture.client.location.reload(fixture.options());
    const reloadDeadline = Date.now() + 5000;
    let reloaded = false;
    while (Date.now() < reloadDeadline) {
      const plugins = await fixture.client.plugin.list({ location: fixture.location }, fixture.options());
      if (plugins.data.some(plugin => plugin.id === "play-nice" && plugin.state.status === "active")) { reloaded = true; break; }
      await pause(30);
    }
    expect(reloaded, "owned location must reactivate the plugin after reload").toBe(true);
    const commands = await fixture.client.command.list({ location: fixture.location }, fixture.options());
    expect(commands.data.map(command => command.name), "Missing native play-nice command registration").toContain("play-nice");

    const other = await session(fixture);
    const providerBeforeEmpty = fixture.services.providerAttempts;
    const decisionsBeforeEmpty = fixture.services.decision.requests.length;
    const toastBeforeEmpty = ui.toasts.length;
    await fixture.client.session.command({ sessionID: other.id, name: "play-nice", text: "" }, fixture.options());
    expect(ui.toasts.slice(toastBeforeEmpty).some(toast => toast.sessionID === other.id && /no .*history/i.test(toast.message))).toBe(true);
    expect(fixture.services.providerAttempts).toBe(providerBeforeEmpty);
    expect(fixture.services.decision.requests).toHaveLength(decisionsBeforeEmpty);

    const question = "Why might that wording sound dismissive?";
    for (const argument of ["", question]) {
      const before = new Set((await messages(fixture, target.id)).map(message => message.id));
      const decisions = fixture.services.decision.requests.length;
      const provider = fixture.services.providerAttempts;
      await fixture.client.session.command({ sessionID: target.id, name: "play-nice", text: argument }, fixture.options());

      const deadline = Date.now() + 12000;
      let generated: Awaited<ReturnType<typeof messages>>[number] | undefined;
      while (Date.now() < deadline) {
        generated = (await messages(fixture, target.id)).find(message => message.type === "user" && !before.has(message.id));
        if (generated?.type === "user" && fixture.services.providerAttempts > provider) break;
        await pause(30);
      }
      expect(generated?.type, "command must submit a reflection prompt to the session agent").toBe("user");
      if (!generated || generated.type !== "user") throw new Error("Missing generated reflection prompt");
      expect(generated.text).toContain(text);
      expect(generated.text).toContain("2.5");
      if (argument) expect(generated.text).toContain(argument);
      await completed(fixture, target.id, generated.id, generated.text);
      expect(fixture.services.providerAttempts).toBeGreaterThan(provider);
      expect(fixture.services.providerBodies.slice(provider).some(body => body.includes("reflection-evidence-please-fix-this-now") && body.includes("2.5"))).toBe(true);
      if (argument) expect(fixture.services.providerBodies.slice(provider).some(body => body.includes(argument))).toBe(true);
      expect(fixture.services.decision.requests, "generated reflection must not be classified").toHaveLength(decisions);
    }

    const ordinary = "reflection-followup-ordinary-prompt";
    await finish(fixture, ui, start(fixture, ui, target.id, ordinary, { kind: "score", score: 4 }), 4, "allowed");
    expect(fixture.services.decision.requests.map(request => request.state)).toEqual([text, ordinary]);
    expect(fixture.services.faults).toEqual([]);
    await fixture.recordReceipt({ status: "passed", commandDiscovered: true, locationReload: true, sessionIsolation: true, bareAndFocusedReflection: true, generatedPromptNotScored: true, ordinaryPromptScored: true });
  } finally { await fixture.close(); }
});

it("assembled queued reflection waits for an active provider turn without Decision rescore", async () => {
  const fixture = await nativeFixture("assembled-default");
  try {
    const ui = await headless(fixture);
    const target = await session(fixture);
    const evidence = "queued-reflection-seed";
    await finish(fixture, ui, start(fixture, ui, target.id, evidence, { kind: "score", score: 2.5 }), 2.5, "allowed");
    fixture.services.holdNextProvider();
    const turn = start(fixture, ui, target.id, "queued-active-turn", { kind: "score", score: 4 });
    await bounded(fixture.services.providerHeld(), "active provider response held");
    const attempts = fixture.services.providerAttempts;
    const decisions = fixture.services.decision.requests.length;
    await fixture.client.session.command({ sessionID: target.id, name: "play-nice", text: "queued question", delivery: "queue" }, fixture.options());
    const queued = (await fixture.client.session.inbox.list({ sessionID: target.id }, fixture.options()))
      .find(item => item.type === "user" && item.payload.text.includes("queued question"));
    expect(queued?.type, "reflection must be admitted to the native inbox while provider is held").toBe("user");
    if (!queued || queued.type !== "user") throw new Error("Missing queued reflection");
    expect(queued.delivery).toBe("queue");
    expect(queued.payload.text).toContain(evidence);
    expect(queued.payload.text).toContain("2.5");
    expect(fixture.services.providerAttempts).toBe(attempts);
    expect(fixture.services.decision.requests).toHaveLength(decisions);
    fixture.services.releaseProvider();
    await finish(fixture, ui, turn, 4, "allowed");
    await completed(fixture, target.id, queued.id, queued.payload.text);
    expect(fixture.services.providerAttempts).toBeGreaterThan(attempts);
    expect(fixture.services.providerBodies.slice(attempts).some(body => body.includes("queued question") && body.includes(evidence))).toBe(true);
    expect(fixture.services.decision.requests).toHaveLength(decisions);
    await finish(fixture, ui, start(fixture, ui, target.id, "queued-followup-ordinary", { kind: "score", score: 4 }), 4, "allowed");
    expect(fixture.services.decision.requests.map(request => request.state)).toEqual([evidence, "queued-active-turn", "queued-followup-ordinary"]);
    expect(fixture.services.faults).toEqual([]);
    await fixture.recordReceipt({ status: "passed", queuedReflection: true, generatedPromptNotScored: true, ordinaryPromptScored: true });
  } finally { await fixture.close(); }
});

it("assembled opt-in blocks rude and abusive after toast receipt, then accepts an edited submission and an idempotent retry", async () => {
  const fixture = await nativeFixture("assembled-reject");
  try {
    const ui = await headless(fixture, true);
    const target = await session(fixture);
    const rude = start(fixture, ui, target.id, "assembled-held-rude", { kind: "score", score: 1 }, true);
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
    await finish(fixture, ui, rude, 1, "blocked");
    const abusive = start(fixture, ui, target.id, "assembled-abusive", { kind: "score", score: 0 });
    await finish(fixture, ui, abusive, 0, "blocked");
    const edited = start(fixture, ui, target.id, "assembled-edited-neutral", { kind: "score", score: 3 });
    await finish(fixture, ui, edited, 3, "allowed");
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

it("assembled fractional cutoff blocks strictly below and allows equality", async () => {
  const fixture = await nativeFixture("assembled-override");
  try {
    const ui = await headless(fixture);
    const target = await session(fixture);
    for (const score of [2, 2.24, 2.25, 2.26] as const) {
      const turn = start(fixture, ui, target.id, `assembled-override-${score}`, { kind: "score", score });
      await finish(fixture, ui, turn, score, score < 2.25 ? "blocked" : "allowed");
    }
    await fixture.recordReceipt({ status: "passed", cutoffOverrideVerified: true });
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
    const turn = start(fixture, ui, target.id, "assembled-failed-toast-abusive", { kind: "score", score: 0 });
    const event = await feedback(ui, turn);
    expect(await bounded(ui.gate.started, "failed toast negative receipt")).toEqual({ invocationID: event.invocationID, displayed: false, directory: fixture.location.directory });
    expect(turn.pending.settled()).toBe(false);
    await noAdmission(fixture, target.id, turn.id, turn.baseline, ui.observer);
    ui.gate.release();
    await finish(fixture, ui, turn, 0, "blocked", false);
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
      start(fixture, ui, first.id, "assembled-concurrent-rude", { kind: "score", score: 1 }),
      start(fixture, ui, second.id, "assembled-concurrent-abusive", { kind: "score", score: 0 }),
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
