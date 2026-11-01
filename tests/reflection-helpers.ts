import type { Plugin } from "@opencode/plugin";
import type { CommandDefinition, CommandEditor } from "@opencode/plugin/promise/command";
import type { SessionPrompt } from "@opencode/plugin/promise/session";
import type { StorageDomain } from "@opencode/plugin/promise/storage";
import { createServerPlugin, type NativeBoundaryDependencies } from "../src/server.js";
import type { FeedbackEvent } from "../src/rpc.js";

export function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("uninitialized deferred"); };
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

export function memoryStorage() {
  const data = new Map<string, Parameters<StorageDomain["set"]>[1]>();
  const storage: StorageDomain = {
    get: async key => data.get(key),
    set: async (key, value) => { data.set(key, value); },
    remove: async key => { data.delete(key); },
    scan: async ({ prefix, after, limit = 100 }) => {
      const keys = [...data.keys()].filter(key => key.startsWith(prefix) && (!after || key > after)).sort();
      const selected = keys.slice(0, limit);
      return { entries: selected.map(key => ({ key, value: data.get(key) ?? null })),
        ...(keys.length > limit ? { next: selected[selected.length - 1] } : {}) };
    },
  };
  return { storage, data };
}

export async function reflectionHarness(options: {
  storage: StorageDomain;
  classify: NativeBoundaryDependencies["classify"];
  prompt?: (input: { sessionID: string; id: string; text: string; delivery: string }) => Promise<unknown>;
  timeout?: number;
}) {
  let hook: ((event: SessionPrompt) => Promise<void> | void) | undefined;
  let command: CommandDefinition | undefined;
  let receipt: ((value: { invocationID: string; displayed: boolean }, context: { signal: AbortSignal }) => Promise<{ accepted: boolean }>) | undefined;
  const feedback: FeedbackEvent[] = [];
  const submissions: Array<{ sessionID: string; id: string; text: string; delivery: string }> = [];
  const context = {
    storage: options.storage,
    rpc: { register: async (_definition: unknown, handlers: { receipt: typeof receipt }) => {
      receipt = handlers.receipt;
      return { dispose: async () => {}, events: { emit: async (_name: string, event: FeedbackEvent) => {
        feedback.push(event);
        await receipt?.({ invocationID: event.invocationID, displayed: true }, { signal: new AbortController().signal });
      } } };
    } },
    session: {
      get: async () => ({}), context: async () => [],
      hook: async (_name: string, callback: typeof hook) => { hook = callback; return { dispose: async () => {} }; },
      prompt: async (input: { sessionID: string; id: string; text: string; delivery: string }) => {
        submissions.push(input);
        if (options.prompt) return options.prompt(input);
        if (!hook) throw new Error("prompt hook missing");
        await hook({ sessionID: input.sessionID, messageID: input.id, prompt: { text: input.text }, delivery: input.delivery } as unknown as SessionPrompt);
        return {};
      },
    },
    command: { transform: async (transform: (editor: CommandEditor) => void) => {
      transform({ add: definition => { command = definition; } });
      return { dispose: async () => {} };
    } },
  };
  const dispose = await createServerPlugin({ classify: options.classify, feedbackTimeoutMs: options.timeout ?? 50 }).setup(context as unknown as Plugin.Context);
  if (!hook || !command || !dispose) throw new Error("fixture registrations missing");
  const registeredHook = hook;
  const registeredCommand: CommandDefinition = command;
  return {
    feedback, submissions,
    submit: (sessionID: string, messageID: string, text: string) => Promise.resolve(registeredHook({ sessionID, messageID, prompt: { text }, delivery: "queue" } as unknown as SessionPrompt)),
    command: (sessionID: string, text: string) => registeredCommand.execute({ sessionID, prompt: { text }, delivery: "queue" } as unknown as Parameters<CommandDefinition["execute"]>[0]),
    close: dispose,
  };
}
