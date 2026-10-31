/** Test seam for the pre-admission policy. Native hook wiring is not established yet. */
export interface PromptBoundaryDependencies {
  classify(text: string): Promise<"allowed" | "blocked">;
  notify(outcome: "allowed" | "blocked"): Promise<void>;
  notificationFailed(): void;
}

export async function checkPrompt(
  text: string,
  dependencies: PromptBoundaryDependencies,
): Promise<void> {
  const outcome = await dependencies.classify(text);
  try {
    await dependencies.notify(outcome);
  } catch {
    dependencies.notificationFailed();
  }
  if (outcome === "blocked") {
    throw new Error("Prompt rejected by Play Nice");
  }
}
