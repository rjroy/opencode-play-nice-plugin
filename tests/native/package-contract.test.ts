import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import server from "opencode-play-nice-plugin/server";
import tui from "opencode-play-nice-plugin/tui";
import { feedbackRpc } from "opencode-play-nice-plugin/rpc";
import { record } from "./support.js";

// Packaging contract checks do not call setup, launch native code or contact a
// classifier. This is separate from the behavior-characterization native suite.
it("resolves the private local package's actual default server, TUI and RPC exports", async () => {
  const manifest: unknown = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  expect(manifest).toMatchObject({ name: "opencode-play-nice-plugin", private: true, type: "module", packageManager: "bun@1.4.3" });
  expect(server.id).toBe("play-nice");
  expect(typeof server.setup).toBe("function");
  expect(tui.id).toBe("play-nice");
  expect(typeof tui.setup).toBe("function");
  expect(feedbackRpc.id).toBe("play-nice");
});

it("defines an executable package build rather than treating no-emit typecheck as a build", async () => {
  const manifest: unknown = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  if (!record(manifest) || !record(manifest.scripts)) throw new Error("Missing package scripts");
  expect(typeof manifest.scripts.build, "Packaging gap: package.json must define a real build command").toBe("string");
  if (typeof manifest.scripts.build !== "string") return;
  expect(manifest.scripts.build.trim().length).toBeGreaterThan(0);
  expect(manifest.scripts.build).not.toBe(manifest.scripts.typecheck);
  expect(manifest.scripts.build).not.toContain("--noEmit");
});
