import type { StorageDomain } from "@opencode/plugin/promise/storage";

export interface ToneRecord {
  version: 1;
  sessionID: string;
  messageID: string;
  text: string;
  score: number;
  outcome: "allowed" | "blocked";
  model: string;
  time: number;
}

const prefix = "reflection/v1/";
const age = 30 * 24 * 60 * 60 * 1000;
const keyOf = (record: Pick<ToneRecord, "sessionID" | "messageID">) =>
  `${prefix}${encodeURIComponent(record.sessionID)}/${encodeURIComponent(record.messageID)}`;

function valid(value: unknown): value is ToneRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return r.version === 1 && typeof r.sessionID === "string" && !!r.sessionID &&
    typeof r.messageID === "string" && !!r.messageID && typeof r.text === "string" &&
    typeof r.score === "number" && Number.isFinite(r.score) && r.score >= 2 && r.score <= 3 &&
    (r.outcome === "allowed" || r.outcome === "blocked") && typeof r.model === "string" &&
    typeof r.time === "number" && Number.isFinite(r.time);
}

export function createHistory(storage: StorageDomain, now: () => number = Date.now) {
  type Job = { run: () => void; cancel: () => void };
  const queue: Job[] = [];
  let busy = false;
  const check = (signal?: AbortSignal) => {
    if (signal?.aborted) throw new Error("History operation cancelled");
  };
  function drain() {
    if (busy) return;
    const job = queue.shift();
    if (job) { busy = true; job.run(); }
  }
  function exclusive<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    if (signal?.aborted) return Promise.reject(new Error("History operation cancelled"));
    if (queue.length >= 100) return Promise.reject(new Error("History queue is full"));
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        cancel() {
          const index = queue.indexOf(job);
          if (index >= 0) queue.splice(index, 1);
          signal?.removeEventListener("abort", job.cancel);
          reject(new Error("History operation cancelled"));
        },
        run() {
          void Promise.resolve().then(() => { check(signal); return work(); }).then(resolve, reject).finally(() => {
            signal?.removeEventListener("abort", job.cancel);
            busy = false;
            drain();
          });
        },
      };
      signal?.addEventListener("abort", job.cancel, { once: true });
      queue.push(job);
      drain();
    });
  }
  async function prune(signal?: AbortSignal): Promise<ToneRecord[]> {
    const entries: { key: string; record: ToneRecord }[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      if (++pages > 20) throw new Error("History scan limit exceeded");
      check(signal);
      const page = await storage.scan({ prefix, limit: 100, ...(after ? { after } : {}) });
      check(signal);
      for (const entry of page.entries) {
        if (!valid(entry.value) || keyOf(entry.value) !== entry.key || entry.value.time < now() - age || entry.value.time > now()) {
          check(signal);
          await storage.remove(entry.key);
          check(signal);
        } else entries.push({ key: entry.key, record: entry.value });
      }
      if (page.next && page.next === after) throw new Error("History scan did not advance");
      after = page.next;
    } while (after);
    entries.sort((a, b) => b.record.time - a.record.time || a.key.localeCompare(b.key));
    for (const entry of entries.slice(200)) { check(signal); await storage.remove(entry.key); check(signal); }
    return entries.slice(0, 200).map(entry => entry.record);
  }
  return {
    write(record: ToneRecord, signal?: AbortSignal) { return exclusive(signal, async () => {
      await prune(signal);
      const key = keyOf(record);
      check(signal);
      const existing = await storage.get(key);
      check(signal);
      if (existing === undefined) { await storage.set(key, { ...record }); check(signal); }
      await prune(signal);
    }); },
    read(sessionID: string, signal?: AbortSignal) { return exclusive(signal, async () => (await prune(signal)).filter(record => record.sessionID === sessionID).slice(0, 10)); },
    clear(sessionID: string, signal?: AbortSignal) { return exclusive(signal, async () => {
      const records = await prune(signal);
      for (const record of records) if (record.sessionID === sessionID) { check(signal); await storage.remove(keyOf(record)); check(signal); }
    }); },
  };
}
