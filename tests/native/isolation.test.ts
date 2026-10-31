import { join } from "node:path";
import { expect, it } from "vitest";
import { fixtureConfig, prepareIsolatedLaunch, type Inspect, type IsolationInput } from "./isolation.js";
import { readinessFromOutput } from "./readiness.js";

function owned(): IsolationInput {
  const root = "/tmp/opencode/play-nice-owned";
  const pluginPackage = join(root, "plugin");
  const origin = "http://127.0.0.1:54321";
  return {
    root, cwd: join(root, "workspace"), executable: "/owned/opencode.exe", providerOrigin: origin,
    pluginPackage, config: JSON.stringify(fixtureConfig(origin, pluginPackage)), password: "test-only",
    paths: {
      HOME: join(root, "home"), OPENCODE_TEST_HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config-home"),
      XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
      TMPDIR: join(root, "tmp"), OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_DB: join(root, "db/opencode.db"),
      GIT_CONFIG_GLOBAL: join(root, "empty.gitconfig"),
    },
  };
}
const inspect: Inspect = async path => path === "/etc/opencode" || path.endsWith("opencode.db") ? "missing"
  : /(?:\.ts|\.json|\.gitconfig)$/.test(path) ? "file" : "directory";

it("allows precisely the owned plugin with its options and constructs a fresh environment", async () => {
  const input = owned();
  input.paths.HTTPS_PROXY = "http://host.invalid";
  const spec = await prepareIsolatedLaunch(input, inspect);
  expect(spec.args).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "0"]);
  expect(spec.env).not.toHaveProperty("HTTPS_PROXY");
  expect(JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT).plugins).toEqual(fixtureConfig(input.providerOrigin, input.pluginPackage).plugins);
});

it.each(["plugin-path", "extra-plugin", "extra-option", "provider", "mcp"])("rejects configuration expansion: %s", async change => {
  const input = owned();
  const config = fixtureConfig(input.providerOrigin, input.pluginPackage);
  if (change === "plugin-path") config.plugins[0] = { package: "/personal/plugin", options: { classificationURL: `${input.providerOrigin}/classify`, feedbackTimeoutMs: 2000 } };
  if (change === "extra-plugin") config.plugins.push({ package: "/personal/plugin", options: { classificationURL: `${input.providerOrigin}/classify`, feedbackTimeoutMs: 2000 } });
  const expanded = change === "extra-option" ? { ...config, plugins: [{ package: input.pluginPackage, options: { ...config.plugins[0]?.options, endpoint: "http://host.invalid" } }] }
    : change === "mcp" ? { ...config, mcp: { servers: {} } }
    : change === "provider" ? { ...config, providers: { live: {} } } : config;
  input.config = JSON.stringify(expanded);
  await expect(prepareIsolatedLaunch(input, inspect)).rejects.toThrow("exact owned profile");
});

it.each(["symlink", "error", "file"] as const)("fails closed for system configuration inspection: %s", async state => {
  await expect(prepareIsolatedLaunch(owned(), async path => path === "/etc/opencode" ? state : inspect(path))).rejects.toThrow("system configuration");
});

it("rejects escaping selectors and symlinked plugin parents", async () => {
  const input = owned();
  input.paths.HOME = "/home/operator";
  await expect(prepareIsolatedLaunch(input, inspect)).rejects.toThrow("HOME");
  const safe = owned();
  await expect(prepareIsolatedLaunch(safe, async path => path === safe.pluginPackage ? "symlink" : inspect(path))).rejects.toThrow("owned directory");
});

it("accepts only complete loopback readiness lines on non-application ports", () => {
  expect(readinessFromOutput("server listening on http://127.0.0.1:54321\n")).toBe("http://127.0.0.1:54321");
  for (const line of ["server listening on http://0.0.0.0:54321\n", "server listening on http://127.0.0.1:3000\n", "server listening on http://127.0.0.1:54321"]) expect(readinessFromOutput(line)).toBeUndefined();
});

it.each(["assembled-default", "assembled-reject", "assembled-override"] as const)("allows only the owned Decision/provider endpoints for %s", async profile => {
  const input = owned();
  input.profile = profile;
  input.config = JSON.stringify(fixtureConfig(input.providerOrigin, input.pluginPackage, profile));
  const spec = await prepareIsolatedLaunch(input, inspect);
  const config: unknown = JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT);
  expect(config).toMatchObject({ plugins: [{ package: input.pluginPackage, options: { endpoint: `${input.providerOrigin}/v1/systemone` } }] });
  const unsafe = fixtureConfig(input.providerOrigin, input.pluginPackage, profile);
  input.config = JSON.stringify({ ...unsafe, plugins: [{ package: input.pluginPackage, options: { endpoint: "http://localhost:11434/v1/systemone", timeoutMs: 2000 } }] });
  await expect(prepareIsolatedLaunch(input, inspect)).rejects.toThrow("exact owned profile");
});
