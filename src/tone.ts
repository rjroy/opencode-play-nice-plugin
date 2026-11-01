/** Ordered from least to most kind; array positions define the score levels. */
export const toneCriteria: readonly string[] = Object.freeze([
  "Abusive: severe personal abuse, threats, harassment, or hateful attacks directed at a person or group.",
  "Rude: disrespectful or insulting remarks directed at a person, without threats, hate, or severe abuse.",
  "Frustrated: expresses frustration or dissatisfaction, including incidental profanity, without attacking a person.",
  "Neutral: matter-of-fact requests, blunt criticism, or quoted hostile words without a hostile attitude toward a person.",
  "Kind: friendly, appreciative, considerate, or supportive communication.",
]);

/** Scores have already been validated; each criterion starts with its identifier. */
export function toneIdentifier(score: number): string {
  const criterion = toneCriteria[Math.round(score)];
  if (criterion === undefined) throw new RangeError("Invalid tone score");
  return criterion.slice(0, criterion.indexOf(":")).toLowerCase();
}

export const toneInstructions = "Rate the tone of the current user message, not the user's character. Distinguish the user's own attitude from words merely quoted or discussed; profanity alone does not imply a personal attack.";
