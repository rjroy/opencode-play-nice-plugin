import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { fakeServices } from "./fake-services.js";
import { contained, fixtureConfig, prepareIsolatedLaunch, type Inspect } from "./isolation.js";
import { preflightExecutable } from "./native-binary.js";
import { readinessFromOutput } from "./readiness.js";
import { bounded, deferred, pause, record } from "./support.js";

const anchor = "/tmp/opencode";
const inspect: Inspect = async path => {
  try {
    const state = await lstat(path);
    return state.isSymbolicLink() ? "symlink" : state.isDirectory() ? "directory" : state.isFile() ? "file" : "error";
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT" ? "missing" : "error";
  }
};

function groupExists(pid: number) {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}
function signalGroup(pid: number, signal: NodeJS.Signals) {
  try { process.kill(-pid, signal); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}
async function stopChild(child: ChildProcessWithoutNullStreams) {
  const pid = child.pid;
  // A failed spawn has no process group to own.
  if (pid === undefined) return;
  const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, "exit").then(() => {});
  signalGroup(pid, "SIGTERM");
  try { await bounded(exited, "owned child termination", 2500); }
  catch { signalGroup(pid, "SIGKILL"); await bounded(exited, "owned child kill", 2500); }
  if (groupExists(pid)) signalGroup(pid, "SIGKILL");
  const deadline = Date.now() + 3000;
  while (groupExists(pid) && Date.now() < deadline) await pause(25);
  if (groupExists(pid)) throw new Error("owned process group remains after cleanup");
}

async function copyPlugin(root: string) {
  const plugin = join(root, "plugin");
  await mkdir(join(plugin, "src"), { recursive: true, mode: 0o700 });
  await mkdir(join(plugin, "tests/native"), { recursive: true, mode: 0o700 });
  for (const name of ["server", "tui", "rpc", "prompt-boundary"]) {
    await copyFile(fileURLToPath(new URL(`../../src/${name}.ts`, import.meta.url)), join(plugin, `src/${name}.ts`));
  }
  await copyFile(fileURLToPath(new URL("./controlled-server.ts", import.meta.url)), join(plugin, "tests/native/controlled-server.ts"));
  // A self-contained package snapshot: no project config, node_modules link,
  // lifecycle scripts or package installation. Native supplies its plugin SDK.
  await writeFile(join(plugin, "package.json"), JSON.stringify({
    name: "opencode-play-nice-plugin", version: "0.0.0", type: "module",
    exports: { "./server": "./tests/native/controlled-server.ts", "./tui": "./src/tui.ts", "./rpc": "./src/rpc.ts" },
  }), { mode: 0o600, flag: "wx" });
  return plugin;
}

/** Nothing runs at module import. Only the explicit native suite calls this. */
export async function nativeFixture() {
  const executable = process.env.OPENCODE_TEST_BINARY;
  if (!executable) throw new Error("OPENCODE_TEST_BINARY is required; no PATH fallback or install is permitted");
  await preflightExecutable(executable);
  if (await inspect("/etc/opencode") !== "missing") throw new Error("system OpenCode configuration is not definitely absent");
  if (await inspect(anchor) !== "directory" || await realpath(anchor) !== anchor) throw new Error("untrusted fixture anchor");
  const root = await mkdtemp(join(anchor, "play-nice-native-"));
  const receiptPath = join(anchor, `play-nice-receipt-${randomBytes(16).toString("hex")}.json`);
  const receipt: Record<string, string | number | boolean> = { status: "prepared", root };
  const recordReceipt = (update: Record<string, string | number | boolean>) => {
    Object.assign(receipt, update);
    // Small synchronous receipts cannot interleave or delay attaching process
    // observation handlers while an early spawn/exit failure is delivered.
    writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  };
  const services = fakeServices();
  const children: ChildProcessWithoutNullStreams[] = [];
  const followers: Array<() => Promise<void>> = [];
  const requestController = new AbortController();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    requestController.abort();
    for (const follower of followers) { try { await follower(); } catch (error) { errors.push(error); } }
    for (const child of children.reverse()) { try { await stopChild(child); } catch (error) { errors.push(error); } }
    try { await services.close(); } catch (error) { errors.push(error); }
    await recordReceipt({ cleanup: errors.length ? "failed" : "processes-and-followers-stopped", providerAttempts: services.providerAttempts, serviceFaults: services.faults.length });
    // Do not erase evidence under a process that could still be alive.
    if (!errors.length) {
      if (!contained(anchor, root) || await realpath(root) !== root) throw new Error("unsafe cleanup root");
      await rm(root, { recursive: true, force: true });
      if (await inspect(root) !== "missing") throw new Error("fixture root remains after cleanup");
      await recordReceipt({ cleanup: "verified", rootRemoved: true });
    }
    console.info("play_nice_native_receipt", receiptPath);
    if (errors.length) throw new AggregateError(errors, "native fixture cleanup failed; owned root retained");
  };
  try {
    await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600, flag: "wx" });
    await Promise.all(["home", "xdg-config", "data", "cache", "state", "tmp", "config", "db", "workspace"].map(dir => mkdir(join(root, dir), { mode: 0o700 })));
    await writeFile(join(root, "empty.gitconfig"), "", { mode: 0o600, flag: "wx" });
    const pluginPackage = await copyPlugin(root);
    const origin = await services.start();
    const password = randomBytes(24).toString("hex");
    const cwd = join(root, "workspace");
    const paths = {
      HOME: join(root, "home"), OPENCODE_TEST_HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
      TMPDIR: join(root, "tmp"), OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_DB: join(root, "db/opencode.db"), GIT_CONFIG_GLOBAL: join(root, "empty.gitconfig"),
    };
    const spec = await prepareIsolatedLaunch({ root, cwd, executable, providerOrigin: origin, pluginPackage, paths,
      config: JSON.stringify(fixtureConfig(origin, pluginPackage)), password }, inspect);
    const launch = async (args: string[], phase: string) => {
      await recordReceipt({ phase: `${phase}-attempt` });
      const child = spawn(executable, args, { cwd: spec.cwd, env: spec.env, detached: true, stdio: "pipe" });
      children.push(child);
      child.stdin.end();
      // Attach immediately: spawn errors cannot become unhandled events.
      const failed = deferred<Error>();
      child.on("error", () => failed.resolve(new Error(`owned ${phase} spawn failed`)));
      // No await after spawn: the caller attaches output/exit listeners in the
      // next microtask, before the event loop can deliver child output.
      return { child, failed: failed.promise.then(error => { throw error; }) };
    };
    const version = await launch(["--version"], "version");
    let versionOutput = "";
    const collectVersion = (chunk: Buffer) => { versionOutput += chunk.toString(); if (versionOutput.length > 4096) versionOutput = "overflow"; };
    version.child.stdout.on("data", collectVersion); version.child.stderr.on("data", collectVersion);
    const versionClosed = Promise.race([once(version.child, "close"), version.failed]);
    if (version.child.pid !== undefined) await recordReceipt({ versionPid: version.child.pid, versionProcessGroup: version.child.pid });
    const [code, signal] = await bounded(versionClosed, "native version", 5000);
    if (code !== 0 || signal !== null || versionOutput.trim() !== "opencode v2.2.2") throw new Error("native version does not match the pinned 2.2.2 output");
    await stopChild(version.child);
    children.splice(children.indexOf(version.child), 1);
    await recordReceipt({ version: "2.2.2", phase: "version-verified" });
    const native = await launch(spec.args, "server");
    let output = "";
    const ready = deferred<string>();
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-65536);
      const address = readinessFromOutput(output);
      if (address) ready.resolve(address);
    };
    native.child.stdout.on("data", collect); native.child.stderr.on("data", collect);
    const listening = Promise.race([ready.promise, native.failed, once(native.child, "exit").then(() => { throw new Error("owned native exited before listening"); })]);
    if (native.child.pid !== undefined) await recordReceipt({ serverPid: native.child.pid, serverProcessGroup: native.child.pid });
    const url = await bounded(listening, "native listening");
    const headers = Service.headers({ url, auth: { type: "basic", username: "opencode", password } });
    // Record status only, never URLs, headers, native error bodies or prompt content.
    const statusesByID = new Map<string, number>();
    // Each instance is the pinned native client, sharing only owned auth and
    // cancellation. A test may observe/gate HTTP but must forward real responses.
    const makeClient = (transport: typeof globalThis.fetch = globalThis.fetch) => OpenCode.make({ baseUrl: url, headers, fetch: async (resource, init) => {
      const signal = init?.signal ? AbortSignal.any([init.signal, requestController.signal]) : requestController.signal;
      const response = await transport(resource, { ...init, signal });
      if (typeof init?.body === "string") {
        const body: unknown = JSON.parse(init.body);
        if (record(body) && typeof body.id === "string") statusesByID.set(body.id, response.status);
      }
      return response;
    } });
    const client = makeClient();
    const options = () => ({ signal: AbortSignal.any([requestController.signal, AbortSignal.timeout(10000)]) });
    const info = await client.server.info(options());
    if (info.version !== "2.2.2" || info.pid !== native.child.pid || !contained(root, info.paths.tmp)) throw new Error("native service identity mismatch");
    const location = { directory: cwd };
    const models = await client.model.list({ location, types: ["chat"] }, options());
    const enabled = models.data.filter(model => model.enabled && model.type === "chat");
    if (enabled.length !== 1 || enabled[0]?.providerID !== "fixture-provider" || enabled[0]?.id !== "fixture-model") throw new Error("non-fixture chat model enabled");
    const plugins = await client.plugin.list({ location }, options());
    const plugin = plugins.data.find(entry => entry.source.type === "local" && entry.source.path === pluginPackage);
    if (!plugin || plugin.id !== "play-nice" || plugin.state.status !== "active") throw new Error("owned Play Nice plugin failed to load (setup failure, not a behavioral RED)");
    await recordReceipt({ phase: "ready", pluginLoaded: true, identityVerified: true });
    return { client, makeClient, services, location, options, close, recordReceipt, statusFor: (id: string) => statusesByID.get(id),
      ownFollower(stop: () => Promise<void>) { followers.push(stop); } };
  } catch (error) {
    await recordReceipt({ status: "setup-failed" });
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "fixture setup and cleanup failed"); }
    throw error;
  }
}
export type NativeFixture = Awaited<ReturnType<typeof nativeFixture>>;
