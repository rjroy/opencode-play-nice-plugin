/** The fixed Decision API taxonomy; descriptions are owned by the client. */
export type Tone = "kind" | "neutral" | "frustrated" | "rude" | "abusive";

export const toneCriteria: Readonly<Record<Tone, string>> = Object.freeze({
  kind: "Friendly, appreciative, considerate, or supportive communication.",
  neutral: "Matter-of-fact requests, blunt criticism, or quoted hostile words without a hostile attitude toward a person.",
  frustrated: "Expresses frustration or dissatisfaction, including incidental profanity, without attacking a person.",
  rude: "Disrespectful or insulting remarks directed at a person, without threats, hate, or severe abuse.",
  abusive: "Severe personal abuse, threats, harassment, or hateful attacks directed at a person or group.",
});

export const toneInstructions = "Classify the tone of the current user message, not the user's character. Distinguish the user's own attitude from words merely quoted or discussed; profanity alone does not imply a personal attack.";

export function isTone(value: unknown): value is Tone {
  return typeof value === "string" && Object.hasOwn(toneCriteria, value);
}
