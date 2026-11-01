export interface PluginSettings {
  autoReject: boolean;
  rejectBelowScore: number;
  endpoint: string;
  model: string;
  timeoutMs: number;
}

/** Validate the V2 plugin options without exposing supplied values in errors. */
export function readSettings(options: unknown): PluginSettings {
  if (typeof options !== "object" || options === null || Array.isArray(options)) throw new Error("Invalid Play Nice options");
  const values = options as Record<string, unknown>;
  if (Object.hasOwn(values, "rejectedCategories")) {
    throw new Error("Play Nice option rejectedCategories was removed; migrate to rejectBelowScore");
  }
  const keys = ["autoReject", "rejectBelowScore", "endpoint", "model", "timeoutMs"];
  if (Object.keys(values).some(key => !keys.includes(key))) throw new Error("Unsupported Play Nice option");

  const autoReject = values.autoReject === undefined ? false : values.autoReject;
  const rejectBelowScore = values.rejectBelowScore === undefined ? 1.5 : values.rejectBelowScore;
  const endpoint = values.endpoint === undefined ? "http://localhost:11434/v1/systemone" : values.endpoint;
  const model = values.model === undefined ? "d3" : values.model;
  const timeoutMs = values.timeoutMs === undefined ? 5000 : values.timeoutMs;
  if (typeof autoReject !== "boolean" || typeof rejectBelowScore !== "number" ||
      !Number.isFinite(rejectBelowScore) || rejectBelowScore < 0 || rejectBelowScore > 4 ||
      typeof endpoint !== "string" || typeof model !== "string" || !model.trim() ||
      typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
    throw new Error("Invalid Play Nice options");
  }
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error("Invalid Play Nice endpoint"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("Invalid Play Nice endpoint");
  }
  return { autoReject, rejectBelowScore, endpoint, model, timeoutMs };
}
