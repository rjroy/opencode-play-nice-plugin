# Native admission test (explicit opt-in)

Authored for OpenCode **2.2.2**, Linux x64, Node >=22 (Vitest 5), and the
already-installed dependencies in `bun.lock`. Native execution is explicit.

From the repository root, after `bun install --frozen-lockfile` if needed:

```sh
OPENCODE_TEST_BINARY=/home/rjroy/.local/share/mise/installs/npm-opencode-cli/2.2.2/node_modules/.mise/@opencode+cli@2.2.2/node_modules/@opencode/cli/bin/opencode.exe \
  bun --no-env-file run test:native -t 'holds before admission/dispatch'
```

All native cases (including negative receipt, missing receipt, no peer, and the
headless production TUI handler):

```sh
OPENCODE_TEST_BINARY=/home/rjroy/.local/share/mise/installs/npm-opencode-cli/2.2.2/node_modules/.mise/@opencode+cli@2.2.2/node_modules/@opencode/cli/bin/opencode.exe \
  bun --no-env-file run test:native
```

## Production TUI handler (headless)

```sh
OPENCODE_TEST_BINARY=/home/rjroy/.local/share/mise/installs/npm-opencode-cli/2.2.2/node_modules/.mise/@opencode+cli@2.2.2/node_modules/@opencode/cli/bin/opencode.exe \
  bun --no-env-file run test:native -t 'production TUI handler'
```

These two cases directly call the exported **production** `src/tui.ts` setup.
They use the real pinned native client's RPC/event stream and a typed context
whose only supplied UI capability is recording `toast.show`. Unused renderer
and host capabilities throw if accessed; no cast invents a complete native TUI.
Both explicit plugin location and `data.location.default()` routing are covered.
A second production listener for another owned location must ignore the event.

An observation-only peer shares the handler's actual client/event connection,
establishes `server.connected`, and never sends acknowledgements. The HTTP probe
records the production handler's receipt, holds it before network dispatch,
then forwards the unchanged request and reads the native server's real response.
Assertions require the matching toast before its matching receipt, rejection
only after receipt dispatch, native `accepted: true`, and no admission/dispatch
before or after rejection. They deliberately do not order independent HTTP
response completions. Existing transport failure/no-peer tests remain separate.

This is **production handler/API invocation evidence**, not OpenCode TUI-host
loading, a PTY, visible rendering, or draft/composer restoration. No behavioral
tests or native processes were run while authoring this added coverage; it may
already pass and does not require an artificial RED.

Prerequisites: trusted pre-existing `/tmp/opencode` (not a link), definitely absent
`/etc/opencode`, and that explicit trusted installation, including its sibling
`@opencode+cli-linux-x64@2.2.2` platform package. Preflight checks canonical paths,
regular executables, ELF magic, exact package versions and binary identity, then
checks `--version` using the isolated environment. It never selects PATH,
installs native packages, discovers a personal service, or edits host config.
Do not remove system config to make this pass.

The fixture copies only the four named source files plus a test-only dependency
adapter into a fresh owned package. Config uses `plugins: [{ package: absolute,
options: { classificationURL, feedbackTimeoutMs } }]`. The adapter injects a held
classifier into **our real server factory**; it does not register a test prompt
hook or receipt handler. The guard permits exactly that owned package/options
and one fake loopback provider. HOME, every XDG home, DB, config and git config
are test-owned; the native environment is constructed without host spreading.

Expected initial RED: the package loads as `play-nice` and the positive control
completes through the fake provider, then the assertion
`Missing native Play Nice prompt hook: admission must wait for our classifier`
receives `prompt admitted before classifier` instead of `classifier-entered`.
An import/setup/version/identity error is **not** this behavioral RED.
That was the original skeleton's RED, not a requirement for the later handler
coverage. The server factory now wires the native boundary and TUI transport;
the default server entrypoint still awaits real classifier/policy composition.

After implementation the main test holds classification, checks no inbox/history
admission or new provider attempts, releases a blocked decision, holds the
invocation receipt, rejects a wrong invocation ID, and only then releases the
receipt. It requires rejection (native 500, not timeout cancellation), no durable
blocked input/dispatch, and an edited prompt completing in canonical history.
Failure cases must still block, including a bounded missing-receipt deadline.

**Evidence boundary:** `rpc-receipt-client.ts` is an actual server RPC/event
client with a `server.connected` barrier and location filtering. Its test-owned
`displayed: true` acknowledgement is NOT a call to `ui.toast.show` and NOT proof
of visible pixels, a rendered toast, or TUI edit/composer behavior. The new
headless cases instead exercise the real exported handler before its receipt.
This suite does not launch a native TUI host or PTY. Rendered visibility remains
unproven; a generic native error may replace the toast.

Cleanup aborts/awaits owned followers and requests, terminates only recorded
owned process groups, closes fake service sockets, verifies groups gone, and
removes only the owned directory. Sanitized receipts stay at
`/tmp/opencode/play-nice-receipt-*.json` (no credentials or prompt bodies).
Cleanup failure retains the root and fails the test; it is not hidden.

Pure guard tests, which never spawn native processes: `bun --no-env-file run
test:native:guards`. Ordinary `bun run test` still selects only the seam tests.
