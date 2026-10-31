import assert from "node:assert/strict";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Host } from "@opencode/plugin/host";

// Run this .mjs file with plain node, not stdin/eval --input-type=module. The
// latter is a stdin/eval-only flag and can break file-based loader contexts.
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, "dist");
let stage = "manifest";

try {
  console.info("play_nice_package_check", { state: "manifest-attempt" });
  const output = lstatSync(directory);
  assert.ok(output.isDirectory() && !output.isSymbolicLink(), "dist must be an actual compiled package directory");
  const source = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  assert.equal(manifest.name, source.name);
  assert.equal(manifest.version, source.version);
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, "module");
  assert.deepEqual(manifest.dependencies, source.dependencies);
  console.info("play_nice_package_check", { state: "manifest-complete" });

  stage = "resolve";
  console.info("play_nice_package_check", { state: "resolve-attempt" });
  const entries = Host.resolve({ directory });
  console.info("play_nice_package_check", { state: "resolve-complete" });
  for (const name of ["server", "tui", "rpc"]) {
    stage = `load-${name}`;
    assert.deepEqual(manifest.exports?.[`./${name}`], {
      types: `./${name}.d.ts`, import: `./${name}.js`, default: `./${name}.js`,
    }, `Unexpected compiled ${name} export contract`);
    const entry = entries[name];
    assert.ok(entry, `Missing compiled ${name} export`);
    assert.equal(fileURLToPath(entry), join(directory, `${name}.js`), `Host must not substitute source for compiled ${name}`);
    for (const extension of ["js", "d.ts"]) {
      const stat = lstatSync(join(directory, `${name}.${extension}`));
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Compiled ${name}.${extension} must be a regular file`);
    }
    console.info("play_nice_package_check", { state: "load-attempt", entrypoint: name });
    const module = await Host.load(entry);
    if (name === "rpc") assert.equal(module.feedbackRpc.id, "play-nice");
    else {
      assert.equal(module.default.id, "play-nice");
      assert.equal(typeof module.default.setup, "function");
    }
    console.info("play_nice_package_check", { state: "load-complete", entrypoint: name });
  }
  console.info("play_nice_package_check", { state: "compiled-exports-verified" });
} catch (error) {
  console.error("play_nice_package_check", { state: "failed", stage });
  throw error;
}
