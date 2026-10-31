import { randomBytes } from "node:crypto";
import type { SessionMessageInfo } from "@opencode/client";
import { expect } from "vitest";
import type { NativeFixture } from "./fixture.js";
import type { rpcReceiptClient } from "./rpc-receipt-client.js";
import { bounded, pause } from "./support.js";

export const identity = (prefix: "ses" | "msg") => `${prefix}_fixture_${randomBytes(12).toString("hex")}`;
export async function session(fixture: NativeFixture) {
  return fixture.client.session.create({
    id: identity("ses"), title: "Play Nice owned admission fixture", location: fixture.location,
    model: { providerID: "fixture-provider", id: "fixture-model" },
    permissions: [{ action: "*", resource: "*", effect: "deny" }],
  }, fixture.options());
}
export async function messages(fixture: NativeFixture, sessionID: string): Promise<SessionMessageInfo[]> {
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
export function prompt(fixture: NativeFixture, sessionID: string, id: string, text: string) {
  let settled = false;
  const result = fixture.client.session.prompt({ sessionID, id, text }, fixture.options()).then(
    admission => { settled = true; return { kind: "admitted" as const, admission }; },
    error => { settled = true; return { kind: "rejected" as const, error }; },
  );
  fixture.ownFollower(async () => { await bounded(result, "owned prompt request cleanup", 3000); });
  return { result, settled: () => settled };
}
export async function noAdmission(fixture: NativeFixture, sessionID: string, id: string, baseline: number, peer?: Awaited<ReturnType<typeof rpcReceiptClient>>) {
  expect((await fixture.client.session.inbox.list({ sessionID }, fixture.options())).some(item => item.id === id), "blocked input is in durable inbox").toBe(false);
  expect((await messages(fixture, sessionID)).some(item => item.id === id), "blocked input is in canonical history").toBe(false);
  expect(fixture.services.providerAttempts, "provider dispatched while prompt was held/blocked").toBe(baseline);
  if (peer) expect(peer.admissions.has(id), "blocked input emitted a durable admission event").toBe(false);
}
export async function completed(fixture: NativeFixture, sessionID: string, messageID: string, text: string) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const history = await messages(fixture, sessionID);
    const index = history.findIndex(item => item.id === messageID);
    const user = history[index];
    // The public native assistant schema has no parentID. Fence this turn by
    // its canonical user position rather than accepting an older completed AI.
    const response = index < 0 ? undefined : history.slice(index + 1).find(item => item.type === "assistant" && item.time.completed !== undefined && item.finish === "stop" && !item.error &&
      item.content.some(part => part.type === "text" && part.text === "fixture-model-ok"));
    const info = await fixture.client.session.get({ sessionID }, fixture.options());
    const active = await fixture.client.session.active(fixture.options());
    if (user?.type === "user" && user.text === text && response && info.outcome === "succeeded" && !active[sessionID]) return;
    await pause(30);
  }
  throw new Error("allowed prompt canonical completion timed out");
}
