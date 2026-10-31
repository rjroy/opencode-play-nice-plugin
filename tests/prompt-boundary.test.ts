import { describe, expect, it, vi } from "vitest";
import { checkPrompt, type PromptBoundaryDependencies } from "../src/prompt-boundary.js";

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("not initialized"); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("pre-admission prompt policy (not a native integration test)", () => {
  it("awaits classification and rejection feedback before rejecting", async () => {
    const classification = deferred<"blocked">();
    const feedback = deferred<void>();
    const notify = vi.fn(() => feedback.promise);
    const classify = vi.fn(() => classification.promise);
    const dependencies: PromptBoundaryDependencies = { classify, notify, notificationFailed: vi.fn() };
    const pending = checkPrompt("fixture message", dependencies);
    let settled = false;
    void pending.finally(() => { settled = true; }).catch(() => {});
    await Promise.resolve();
    expect(classify).toHaveBeenCalledWith("fixture message");
    expect(settled).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    classification.resolve("blocked");
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("blocked"));
    expect(settled).toBe(false);
    feedback.resolve();
    await expect(pending).rejects.toThrow();
  });

  it("still rejects when feedback fails and records the failure", async () => {
    const notificationFailed = vi.fn();
    await expect(checkPrompt("fixture message", {
      classify: async () => "blocked",
      notify: async () => { throw new Error("test-owned failure"); },
      notificationFailed,
    })).rejects.toThrow();
    expect(notificationFailed).toHaveBeenCalledOnce();
  });

  it("allows an edited submission after rejection", async () => {
    const classify = vi.fn(async (text: string) => text === "blocked" ? "blocked" as const : "allowed" as const);
    const notify = vi.fn(async (_outcome: "allowed" | "blocked") => {});
    const dependencies: PromptBoundaryDependencies = { classify, notify, notificationFailed: vi.fn() };
    await expect(checkPrompt("blocked", dependencies)).rejects.toThrow();
    await expect(checkPrompt("edited", dependencies)).resolves.toBeUndefined();
    expect(notify.mock.calls).toEqual([["blocked"], ["allowed"]]);
  });
});
