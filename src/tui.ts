import type { Plugin } from "@opencode/plugin/tui";
import { feedbackRpc, readFeedbackEvent, readReceiptAccepted, type FeedbackEvent } from "./rpc.js";

function log(state: string, details: Record<string, string | boolean> = {}) {
  console.info("play_nice_tui", { state, ...details });
}

export default {
  id: "play-nice",
  setup(context) {
    const lifetime = new AbortController();
    const rpc = context.client.rpc(feedbackRpc);
    const running = new Set<Promise<void>>();
    const acknowledge = async (feedback: FeedbackEvent, directory: string) => {
      if (lifetime.signal.aborted) return;
      let displayed = false;
      log("toast-invoke-attempt", { invocationID: feedback.invocationID });
      try {
        context.ui.toast.show({
          title: "Play Nice", message: feedback.message, sessionID: feedback.sessionID,
          variant: feedback.outcome === "blocked" ? "warning" : "info", duration: 5000,
        });
        // This synchronous API returns no renderer/frame acknowledgement.
        displayed = true;
        log("toast-invoke-complete", { invocationID: feedback.invocationID });
      } catch {
        log("toast-invoke-failed", { invocationID: feedback.invocationID });
      }
      log("receipt-attempt", { invocationID: feedback.invocationID, toastInvoked: displayed });
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), 5000);
      try {
        const value = await rpc.receipt({ invocationID: feedback.invocationID, displayed }, {
          // Never route using the client's implicit default: it may have moved.
          location: { directory }, signal: AbortSignal.any([lifetime.signal, deadline.signal]),
        });
        const accepted = readReceiptAccepted(value);
        log(accepted === undefined ? "receipt-invalid-result" : "receipt-complete", {
          invocationID: feedback.invocationID, accepted: accepted ?? false,
        });
      } catch {
        log("receipt-failed", { invocationID: feedback.invocationID, cancelled: lifetime.signal.aborted });
      } finally { clearTimeout(timer); }
    };

    log("feedback-subscribe-attempt");
    const listener = (async () => {
      for await (const event of rpc.events.subscribe("feedback", { signal: lifetime.signal })) {
        if (lifetime.signal.aborted) break;
        const location = context.location ?? context.data.location.default();
        const directory = event.location?.directory;
        if (!directory || directory !== location.directory) continue;
        const feedback = readFeedbackEvent(event.data);
        if (!feedback) { log("feedback-invalid-event"); continue; }
        // Concurrent prompts must not wait behind another receipt HTTP request.
        // Toast invocation still runs synchronously before its own receipt.
        const work = acknowledge(feedback, directory);
        running.add(work);
        void work.then(() => running.delete(work), () => running.delete(work));
      }
      if (!lifetime.signal.aborted) log("feedback-stream-ended");
    })().then(() => {}, () => {
      log("feedback-stream-failed", { cancelled: lifetime.signal.aborted });
    });
    log("feedback-listener-started");
    return async () => {
      log("stop-attempt");
      lifetime.abort();
      await listener;
      await Promise.allSettled([...running]);
      log("stop-complete");
    };
  },
} satisfies Plugin.Definition;
