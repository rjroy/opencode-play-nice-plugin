import { describe, expect, it } from "vitest";
import { readSettings } from "../src/config.js";

describe("plugin options", () => {
  it("uses safe bounded defaults", () => {
    expect(readSettings({})).toEqual({
      autoReject: false, rejectedCategories: ["rude", "abusive"],
      endpoint: "http://localhost:11434/v1/systemone", model: "d3", timeoutMs: 5000,
    });
  });

  it("accepts explicit supported settings including boundary deadlines", () => {
    for (const timeoutMs of [1000, 30000]) {
      expect(readSettings({ autoReject: true, rejectedCategories: ["neutral", "kind"], endpoint: "https://example.test/decision", model: "fixture", timeoutMs }))
        .toEqual({ autoReject: true, rejectedCategories: ["neutral", "kind"], endpoint: "https://example.test/decision", model: "fixture", timeoutMs });
    }
  });

  it.each([
    null, [], { autoReject: "true" }, { rejectedCategories: "rude" }, { rejectedCategories: ["other"] },
    { rejectedCategories: ["rude", 5] }, { endpoint: "not a url" }, { endpoint: "file:///tmp/test" },
    { endpoint: "http://user:password@example.test/" }, { model: "" }, { model: 1 },
    { timeoutMs: 999 }, { timeoutMs: 30001 }, { timeoutMs: 1.5 }, { timeoutMs: "5000" },
    { instructions: "override taxonomy" }, { criteria: {} },
  ])("rejects invalid or unsupported options %#", options => {
    expect(() => readSettings(options)).toThrow();
  });
});
