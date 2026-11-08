/** Ordered tone levels; array positions define the score levels. */
export const toneCriteria: readonly string[] = Object.freeze([
  "Abusive: severe personal abuse, threats, harassment, or hateful attacks directed at a person, group, or AI.",
  "Rude: personal insults, humiliation, or overt contempt directed at a person, group, or AI, without severe abuse.",
  "Dismissive: belittling or dismissing a recipient or their contribution, without overt personal insults or severe abuse.",
  "Neutral: matter-of-fact requests, direct criticism, dissatisfaction, frustration, urgency, or firm boundaries without belittling or attacking a recipient.",
  "Kind: friendly, appreciative, considerate, or supportive communication when expressed, not a required style.",
]);

/** Scores have already been validated; each criterion starts with its identifier. */
export function toneIdentifier(score: number): string {
  const criterion = toneCriteria[Math.round(score)];
  if (criterion === undefined) throw new RangeError("Invalid tone score");
  return criterion.slice(0, criterion.indexOf(":")).toLowerCase();
}

export const toneInstructions = "Rate the wording of the current user message, not the user's character. Apply the same communication standards whether the recipient is human or AI, without attributing feelings to AI. Distinguish the user's own attitude from words merely quoted or discussed. Profanity, frustration, dissatisfaction, urgency, directness, or firm boundaries alone do not imply an attack. Neutral directness is successful communication; warmth is optional and context-dependent, not a universal target. Consider missing context and do not require performative politeness or emotional suppression.";
