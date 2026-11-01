import { describe, expect, it } from "vitest";
import { readSettings } from "../src/config.js";

describe("plugin options", () => {
  it("uses safe bounded defaults", () => {
    expect(readSettings({})).toEqual({
      autoReject: false, rejectBelowScore: 1.5,
      endpoint: "http://localhost:11434/v1/systemone", model: "d3", timeoutMs: 5000,
    });
  });

  it("accepts explicit supported settings including boundary deadlines", () => {
    for (const timeoutMs of [1000, 30000]) {
      expect(readSettings({ autoReject: true, rejectBelowScore: 2.25, endpoint: "https://example.test/decision", model: "fixture", timeoutMs }))
        .toEqual({ autoReject: true, rejectBelowScore: 2.25, endpoint: "https://example.test/decision", model: "fixture", timeoutMs });
    }
  });

  it.each([0, 4, 1.5, 2.25])("accepts score cutoff %s", rejectBelowScore => {
    expect(readSettings({ rejectBelowScore }).rejectBelowScore).toBe(rejectBelowScore);
  });

  it.each([
    { value: ["rude"] }, { value: ["fixture-secret-value"] },
    { value: "fixture-secret-value" }, { value: null },
  ])("reports legacy option migration without leaking its value %#", ({ value }) => {
    let error: unknown;
    try { readSettings({ rejectedCategories: value }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/rejectedCategories/);
    expect(String(error)).toMatch(/rejectBelowScore/);
    expect(String(error)).not.toContain("fixture-secret-value");
  });

  it.each([
    null, [], { autoReject: "true" }, { rejectBelowScore: "1.5" }, { rejectBelowScore: null }, { rejectBelowScore: -0.01 },
    { rejectBelowScore: 4.01 }, { rejectBelowScore: NaN }, { rejectBelowScore: Infinity }, { rejectBelowScore: -Infinity }, { endpoint: "not a url" }, { endpoint: "file:///tmp/test" },
    { endpoint: "http://user:password@example.test/" }, { model: "" }, { model: 1 },
    { timeoutMs: 999 }, { timeoutMs: 30001 }, { timeoutMs: 1.5 }, { timeoutMs: "5000" },
    { instructions: "override taxonomy" }, { criteria: {} },
  ])("rejects invalid or unsupported options %#", options => {
    expect(() => readSettings(options)).toThrow();
  });
});
