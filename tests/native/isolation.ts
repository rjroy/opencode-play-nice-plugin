import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

export type Metadata = "directory" | "file" | "symlink" | "missing" | "error";
export type Inspect = (path: string) => Promise<Metadata>;
const directories = ["HOME", "OPENCODE_TEST_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TMPDIR", "OPENCODE_CONFIG_DIR"] as const;
const files = ["OPENCODE_DB", "GIT_CONFIG_GLOBAL"] as const;
export const forbiddenPorts = new Set([3000, 3001, 9443, 4173, 4317, 48763]);
export const feedbackTimeoutMs = 2000;

export function fixtureConfig(origin: string, pluginPackage: string) {
  return {
    model: "fixture-provider/fixture-model", update: "disable", share: "disabled", snapshots: false,
    plugins: [{ package: pluginPackage, options: { classificationURL: `${origin}/classify`, feedbackTimeoutMs } }],
    providers: {
      "fixture-provider": {
        env: [], package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `${origin}/v1`, apiKey: "fixture-only" },
        models: { "fixture-model": { type: "chat", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 131072, output: 2048 } } },
      },
    },
  };
}

export interface IsolationInput {
  root: string;
  cwd: string;
  executable: string;
  providerOrigin: string;
  pluginPackage: string;
  config: string;
  password: string;
  paths: Record<string, string>;
}

export function contained(root: string, path: string): boolean {
  if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0")) return false;
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function fail(message: string): never { throw new Error(`Isolation guard: ${message}`); }

async function checkPath(root: string, path: string, expected: "directory" | "file" | "database", inspect: Inspect) {
  let current = root;
  const parts = relative(root, path).split(sep);
  for (let index = 0; index <= parts.length; index++) {
    if (index > 0) current = resolve(current, parts[index - 1] ?? fail("invalid path segment"));
    const state = await inspect(current);
    if (index !== parts.length || expected === "directory") {
      if (state !== "directory") fail("expected owned directory");
    } else if (expected === "file" ? state !== "file" : state !== "file" && state !== "missing") fail("invalid owned file");
  }
}

/** Adapted from memory-loop/tests/opencode/isolation.ts. No host env input. */
export async function prepareIsolatedLaunch(input: IsolationInput, inspect: Inspect) {
  const { root, cwd, executable, providerOrigin, pluginPackage, config, password } = input;
  const paths = { ...input.paths };
  if (!isAbsolute(executable) || normalize(executable) !== executable || executable.includes("\0")) fail("invalid binary selector");
  if (!contained("/tmp/opencode", root) || !contained(root, cwd)) fail("invalid root or workspace");
  // Exactly one explicit, test-owned package, not an arbitrary plugin allowlist.
  if (pluginPackage !== join(root, "plugin")) fail("unowned plugin package");
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(providerOrigin);
  if (!match || Number(match[1]) > 65535 || forbiddenPorts.has(Number(match[1]))) fail("invalid provider origin");
  if (!password) fail("missing password");
  let value: unknown;
  try { value = JSON.parse(config); } catch { fail("invalid configuration JSON"); }
  if (!isDeepStrictEqual(value, fixtureConfig(providerOrigin, pluginPackage))) fail("configuration is not the exact owned profile");
  for (const selector of [...directories, ...files]) {
    if (!paths[selector] || !contained(root, paths[selector])) fail(`invalid ${selector}`);
  }
  if (await inspect("/etc/opencode") !== "missing") fail("system configuration is not definitely absent");
  await checkPath(root, cwd, "directory", inspect);
  for (const selector of directories) await checkPath(root, paths[selector] ?? fail(selector), "directory", inspect);
  await checkPath(root, paths.OPENCODE_DB ?? fail("OPENCODE_DB"), "database", inspect);
  await checkPath(root, paths.GIT_CONFIG_GLOBAL ?? fail("GIT_CONFIG_GLOBAL"), "file", inspect);
  for (const path of ["package.json", "tests/native/controlled-server.ts", "src/server.ts", "src/tui.ts", "src/rpc.ts", "src/prompt-boundary.ts"]) {
    await checkPath(root, join(pluginPackage, path), "file", inspect);
  }
  // Copy only the named selectors. Even extra caller-supplied paths cannot
  // inject credentials, proxy variables, preload hooks or other host settings.
  const envPaths = Object.fromEntries([...directories, ...files].map(key => [key, paths[key] ?? fail(key)]));
  return {
    executable, cwd, args: ["serve", "--hostname", "127.0.0.1", "--port", "0"],
    env: {
      ...envPaths, OPENCODE_CONFIG_CONTENT: config, OPENCODE_CONFIG_PROJECT_DISABLE: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FREE_MODELS: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_FILEWATCHER: "1", OPENCODE_DISABLE_FFF: "1",
      OPENCODE_PASSWORD: password, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1",
    },
  };
}
