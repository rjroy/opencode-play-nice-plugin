// Test-only package entrypoint. Inject a controlled classifier into the REAL
// server factory; do not register a substitute prompt hook or feedback bridge.
import { createServerPlugin } from "../../src/server.js";
import type { Plugin } from "@opencode/plugin";

export default {
  id: "play-nice",
  async setup(context) {
    const endpoint: unknown = context.options.classificationURL;
    const timeout: unknown = context.options.feedbackTimeoutMs;
    if (typeof endpoint !== "string" || typeof timeout !== "number") throw new Error("invalid owned fixture options");
    return createServerPlugin({
      feedbackTimeoutMs: timeout,
      async classify(text) {
        const response = await fetch(endpoint, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }), signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error("owned classifier HTTP failure");
        const value: unknown = await response.json();
        if (typeof value !== "object" || value === null || !("outcome" in value) ||
            (value.outcome !== "allowed" && value.outcome !== "blocked")) throw new Error("invalid owned classifier response");
        return value.outcome;
      },
    }).setup(context);
  },
} satisfies Plugin.Plugin;
