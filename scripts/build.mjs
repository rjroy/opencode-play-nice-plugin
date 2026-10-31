import { execFileSync } from "node:child_process";
import { copyFileSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "dist");
let stage = "prepare";

function regularFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Build output must be a regular file");
}

try {
  const source = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const compiler = JSON.parse(readFileSync(join(root, "node_modules/typescript/package.json"), "utf8"));
  if (typeof source.name !== "string" || typeof source.version !== "string" || source.private !== true || compiler.name !== "typescript" ||
      source.devDependencies?.typescript !== compiler.version) {
    throw new Error("Build requires the private package and its exactly pinned TypeScript installation");
  }
  // dist is an exclusively generated build directory. Refuse links or files
  // rather than following/replacing an unexpected target during cleanup.
  try {
    const stat = lstatSync(output);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Refusing to replace a non-directory or linked dist target");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  console.info("play_nice_build", { state: "prepare-attempt" });
  rmSync(output, { recursive: true, force: true });
  console.info("play_nice_build", { state: "prepare-complete" });

  stage = "compile";
  console.info("play_nice_build", { state: "compile-attempt", typescript: compiler.version });
  // Invoke only the installed pinned compiler, never npx, a package installer,
  // a mutable tsc shim, or an unrelated global TypeScript installation.
  execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--project", join(root, "tsconfig.build.json")], {
    cwd: root, stdio: "inherit",
  });
  console.info("play_nice_build", { state: "compile-complete" });

  stage = "package";
  console.info("play_nice_build", { state: "package-attempt" });
  const exports = {};
  for (const name of ["server", "tui", "rpc"]) {
    regularFile(join(output, `${name}.js`));
    regularFile(join(output, `${name}.d.ts`));
    exports[`./${name}`] = { types: `./${name}.d.ts`, import: `./${name}.js`, default: `./${name}.js` };
  }
  // A nested package lets native Host.resolve choose compiled ./server, ./tui
  // and ./rpc without changing the root source-export contract used by tests.
  const manifest = {
    name: source.name, version: source.version, private: true, type: "module",
    packageManager: source.packageManager, exports, dependencies: source.dependencies,
  };
  writeFileSync(join(output, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  copyFileSync(join(root, "LICENSE"), join(output, "LICENSE"));
  console.info("play_nice_build", { state: "package-complete" });
} catch (error) {
  console.error("play_nice_build", { state: "failed", stage });
  throw error;
}
