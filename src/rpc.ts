import type { Rpc } from "@opencode/plugin/rpc";

const invocationIDPattern = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const invocationIDExpression = new RegExp(invocationIDPattern);

/** `displayed` acknowledges a toast API invocation, not a rendered frame. */
export interface FeedbackReceipt {
  invocationID: string;
  displayed: boolean;
}

export interface FeedbackEvent {
  invocationID: string;
  sessionID: string;
  messageID: string;
  outcome: "allowed" | "blocked";
  message: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Portable JSON schemas intentionally infer unknown at RPC boundaries.
export function readFeedbackReceipt(value: unknown): FeedbackReceipt | undefined {
  if (!record(value) || typeof value.invocationID !== "string" || !value.invocationID || typeof value.displayed !== "boolean") return;
  return { invocationID: value.invocationID, displayed: value.displayed };
}

export function readFeedbackEvent(value: unknown): FeedbackEvent | undefined {
  if (!record(value) || typeof value.invocationID !== "string" || !value.invocationID ||
      !invocationIDExpression.test(value.invocationID) ||
      typeof value.sessionID !== "string" || !value.sessionID || typeof value.messageID !== "string" || !value.messageID ||
      typeof value.message !== "string" || !value.message || (value.outcome !== "allowed" && value.outcome !== "blocked")) return;
  return { invocationID: value.invocationID, sessionID: value.sessionID, messageID: value.messageID, outcome: value.outcome, message: value.message };
}

export function readReceiptAccepted(value: unknown): boolean | undefined {
  return record(value) && typeof value.accepted === "boolean" ? value.accepted : undefined;
}

export const feedbackRpc = {
  id: "play-nice",
  methods: {
    receipt: {
      input: {
        type: "object",
        properties: { invocationID: { type: "string" }, displayed: { type: "boolean" } },
        required: ["invocationID", "displayed"],
        additionalProperties: false,
      },
      output: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"], additionalProperties: false },
    },
  },
  events: {
    feedback: {
      schema: {
        type: "object",
        properties: {
          // OpenCode 2.2.2 imports JSON schemas with Effect's default options,
          // which reject `pattern` before publishing. Validate UUIDs locally in
          // readFeedbackEvent instead; the producer always uses randomUUID().
          invocationID: { type: "string" }, sessionID: { type: "string" }, messageID: { type: "string" },
          outcome: { type: "string", enum: ["allowed", "blocked"] }, message: { type: "string" },
        },
        required: ["invocationID", "sessionID", "messageID", "outcome", "message"],
        additionalProperties: false,
      },
    },
  },
} as const satisfies Rpc.PortableDefinition;
