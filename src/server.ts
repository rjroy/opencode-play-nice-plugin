import { randomUUID } from "node:crypto";
import type { Plugin } from "@opencode/plugin";
import type { SessionPrompt } from "@opencode/plugin/promise/session";
import { checkPrompt } from "./prompt-boundary.js";
import { feedbackRpc, readFeedbackReceipt, type FeedbackEvent } from "./rpc.js";

/** Dependency boundary for native integration; not a configurable fixed policy. */
export interface NativeBoundaryDependencies {
  /** The classifier/policy composition owns its deadline and unavailable policy. */
  classify(text: string, signal?: AbortSignal): Promise<"allowed" | "blocked">;
  feedbackTimeoutMs: number;
}

type FeedbackResult = "invoked" | "toast-failed" | "emit-failed" | "timeout" | "cancelled";
type FinishFeedback = (result: FeedbackResult) => boolean;

function log(state: string, details: Record<string, string | number | boolean> = {}) {
  // Never pass native errors, prompt text, options, endpoint URLs or paths.
  console.info("play_nice_server", { state, ...details });
}

function publicationFailure(error: unknown): "unsupported-schema-pattern" | "native-publication-failed" {
  // Categorize the pinned importer's error without logging its arbitrary text
  // or payload. All publication failures still use the same fail-closed path.
  return error instanceof Error && error.message.includes("Patterns may block validation and are disabled")
    ? "unsupported-schema-pattern" : "native-publication-failed";
}

/** Await a dependency without retaining an admission hook after plugin unload. */
async function untilStopped<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("Play Nice stopped before prompt admission");
  let stop = () => {};
  const stopped = new Promise<never>((_, reject) => {
    stop = () => reject(new Error("Play Nice stopped before prompt admission"));
    signal.addEventListener("abort", stop, { once: true });
  });
  try { return await Promise.race([work(), stopped]); }
  finally { signal.removeEventListener("abort", stop); }
}

/** Location-scoped native wiring, independent of the eventual Decision client. */
export function createServerPlugin(dependencies: NativeBoundaryDependencies): Plugin.Plugin {
  const { classify, feedbackTimeoutMs } = dependencies;
  if (!Number.isInteger(feedbackTimeoutMs) || feedbackTimeoutMs < 1 || feedbackTimeoutMs > 30000) {
    throw new RangeError("Play Nice feedback deadline must be an integer between 1 and 30000 ms");
  }
  return {
    id: "play-nice",
    async setup(context) {
      const lifetime = new AbortController();
      const pending = new Map<string, FinishFeedback>();
      const running = new Set<Promise<void>>();
      log("rpc-register-attempt");
      // Native registers and dispatches this RPC in context.location. Each
      // location owns its own map; receipts in another location cannot settle it.
      const rpc = await context.rpc.register(feedbackRpc, {
        async receipt(input, call) {
          const receipt = readFeedbackReceipt(input);
          if (!receipt || call.signal.aborted || lifetime.signal.aborted) return { accepted: false };
          const finish = pending.get(receipt.invocationID);
          const accepted = finish?.(receipt.displayed ? "invoked" : "toast-failed") ?? false;
          // An unknown caller-supplied ID could contain private text. Only log
          // identifiers we generated and still own, not arbitrary RPC input.
          log("receipt", { ...(finish ? { invocationID: receipt.invocationID } : {}), accepted, toastInvoked: receipt.displayed });
          return { accepted };
        },
      }).catch(error => {
        log("rpc-register-failed");
        throw error;
      });
      log("rpc-register-complete");

      const notify = (feedback: FeedbackEvent): Promise<FeedbackResult> => {
        if (lifetime.signal.aborted) return Promise.resolve("cancelled");
        let finish: FinishFeedback = () => false;
        const result = new Promise<FeedbackResult>(resolve => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const stop = () => finish("cancelled");
          finish = outcome => {
            if (!pending.delete(feedback.invocationID)) return false;
            clearTimeout(timer);
            lifetime.signal.removeEventListener("abort", stop);
            resolve(outcome);
            return true;
          };
          // Install the waiter before emitting. A fast TUI can acknowledge
          // while native events.emit is still resolving its publish operation.
          pending.set(feedback.invocationID, finish);
          timer = setTimeout(() => finish("timeout"), feedbackTimeoutMs);
          lifetime.signal.addEventListener("abort", stop, { once: true });
        });
        log("feedback-emit-attempt", { invocationID: feedback.invocationID, outcome: feedback.outcome });
        // This API has no AbortSignal. Bound the receipt wait independently and
        // observe emission failure even if native publication finishes late.
        void Promise.resolve().then(() => {
          if (lifetime.signal.aborted) return false;
          return rpc.events.emit("feedback", { ...feedback }).then(() => true);
        }).then(published => {
          log(published ? "feedback-emit-complete" : "feedback-emit-cancelled", { invocationID: feedback.invocationID });
        }, error => {
          log("feedback-emit-failed", { invocationID: feedback.invocationID, reason: publicationFailure(error) });
          finish("emit-failed");
        });
        return result;
      };

      const handlePrompt = async (event: SessionPrompt): Promise<void> => {
        const invocationID = randomUUID();
        let outcome: "allowed" | "blocked" | undefined;
        let feedbackFailure: FeedbackResult | undefined;
        try {
          await checkPrompt(event.prompt.text, {
            async classify(text) {
              const started = Date.now();
              log("classification-attempt", { invocationID });
              try {
                const value = await untilStopped(() => classify(text, lifetime.signal), lifetime.signal);
                if (value !== "allowed" && value !== "blocked") throw new Error("Invalid Play Nice policy decision");
                outcome = value;
                log("classification-complete", { invocationID, outcome, elapsedMs: Date.now() - started });
                return value;
              } catch {
                log("classification-failed", { invocationID, reason: lifetime.signal.aborted ? "cancelled" : "dependency-failed", elapsedMs: Date.now() - started });
                // Native may persist/log thrown hook errors. Do not forward an
                // HTTP client's arbitrary response, credential or prompt text.
                throw new Error(lifetime.signal.aborted ? "Play Nice stopped before prompt admission" : "Play Nice classification dependency failed");
              }
            },
            async notify(decision) {
              const result = await notify({
                invocationID, sessionID: event.sessionID, messageID: event.messageID, outcome: decision,
                message: decision === "blocked" ? "Prompt rejected by Play Nice. Edit your message and resubmit." : "Prompt allowed by Play Nice.",
              });
              log("feedback-settled", { invocationID, result });
              if (result !== "invoked") {
                feedbackFailure = result;
                throw new Error("Play Nice feedback invocation was not acknowledged");
              }
            },
            notificationFailed() {
              log("feedback-unavailable", { invocationID, reason: feedbackFailure ?? "unknown" });
            },
          });
          if (lifetime.signal.aborted) throw new Error("Play Nice stopped before prompt admission");
          log("prompt-allowed", { invocationID, feedbackAcknowledged: feedbackFailure === undefined });
        } catch (error) {
          if (outcome === "blocked") {
            log("prompt-rejected", { invocationID, feedbackAcknowledged: feedbackFailure === undefined });
            // Keep deliberate rejection outside classification's error boundary.
            // Feedback failure NEVER changes a blocked decision to admission.
            if (feedbackFailure !== undefined) throw new Error(`Prompt rejected by Play Nice; feedback unavailable (${feedbackFailure})`);
          }
          throw error;
        }
      };

      try {
        log("prompt-hook-register-attempt");
        const hook = await context.session.hook("prompt", event => {
          const work = handlePrompt(event);
          running.add(work);
          void work.then(() => running.delete(work), () => running.delete(work));
          return work;
        });
        log("prompt-hook-register-complete");
        return async () => {
          log("stop-attempt", { pendingFeedback: pending.size, pendingPrompts: running.size });
          lifetime.abort();
          // Aborting resolves every waiter and removes its timer/map entry.
          // The native Promise hook exposes no per-request cancellation signal.
          const errors: unknown[] = [];
          try { await hook.dispose(); } catch (error) { errors.push(error); }
          await Promise.allSettled([...running]);
          try { await rpc.dispose(); } catch (error) { errors.push(error); }
          if (errors.length) {
            log("stop-failed", { pendingFeedback: pending.size, pendingPrompts: running.size });
            throw new AggregateError(errors, "Play Nice registration cleanup failed");
          }
          log("stop-complete", { pendingFeedback: pending.size, pendingPrompts: running.size });
        };
      } catch (error) {
        log("prompt-hook-register-failed");
        lifetime.abort();
        await Promise.allSettled([...running]);
        try { await rpc.dispose(); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], "Play Nice hook registration and RPC cleanup failed"); }
        throw error;
      }
    },
  };
}

// The next composition bead connects the real Decision client and policy here.
// Do not ship a fixed classifier, silently install a no-op, or read fixture-only
// options from production. The native integration injects through the factory.
export default {
  id: "play-nice",
  setup() { throw new Error("Play Nice classifier/policy composition is not connected yet"); },
} satisfies Plugin.Plugin;
