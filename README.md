# Play Nice for OpenCode 2.2.2

A private, local V2 plugin that classifies the **current user message** as
`kind`, `neutral`, `frustrated`, `rude`, or `abusive`, reports the judgment, and
optionally rejects selected categories before native prompt admission.
It judges message tone, not a person's character.

**Status:** the production server/client/policy and TUI receipt handler are
implemented. Independent assembled native checks passed against the source
package and the build passed independently. The compiled host-load check now
uses a file entrypoint and requires an independent rerun. The package is private,
not a published npm installation. See [Packaging](#packaging) for the two
entrypoint choices.

## Local package installation

Target the **OpenCode 2.2.2 V2** runtime. V1 plugin APIs are not compatible.
The checkout pins Bun **1.4.3**, `@opencode/plugin` and `@opencode/client`
**2.2.2**, TypeScript **5.9.3**, and Vitest **5.0.5** in `package.json`/`bun.lock`.
Use Node 22.15+ within 22.x, 24.x, or 26+ for the Node-hosted runner and host
import smoke (the pinned resolver uses `node:module.registerHooks`).

In an existing trusted checkout:

```sh
bun --no-env-file install --frozen-lockfile
bun --no-env-file run build
bun --no-env-file run typecheck
```

Add an entry to your workspace's **`opencode.json` or `opencode.jsonc`**. Merge
it with existing settings; do not overwrite unrelated provider or plugin config.
Replace the example absolute directory with the actual checkout directory:

```json
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-play-nice-plugin/dist",
      "options": {
        "endpoint": "http://localhost:11434/v1/systemone",
        "model": "d3",
        "autoReject": false
      }
    }
  ]
}
```

Use **`plugins` plural**, a package **directory**, and an `options` object—not
a V1 hook file or `dist/server.js` path. No `.env` file is needed. Point at
`dist/` for the compiled package after a successful build, or at the checkout
root to develop against the existing TypeScript source package. Both packages
expose the same three names, relative to the selected package directory:

| Package export | Checkout-root package | Compiled `dist/` package |
|---|---|---|
| `opencode-play-nice-plugin/server` | `src/server.ts` | `server.js` + `server.d.ts` |
| `opencode-play-nice-plugin/tui` | `src/tui.ts` | `tui.js` + `tui.d.ts` |
| `opencode-play-nice-plugin/rpc` | `src/rpc.ts` | `rpc.js` + `rpc.d.ts` |

The root exports intentionally remain source paths for source consumers and the
existing native fixture. `dist/package.json` is a separate generated private
V2 manifest; merely building does not switch root imports to compiled code.
Configure one package directory, not both source and compiled copies.

The pinned TUI discovers combined plugins from active server inventory and
loads their `./tui` export; this handler needs no separate TUI options. Inspect
`/plugins` after starting your trusted OpenCode 2.2.2 TUI in that workspace.
The service operator separately supplies a compatible Decision API/model;
this project does not install Ollama, download `d3`, or start a personal service.

## Settings and behavior

| Option | Default | Accepted values |
|---|---|---|
| `autoReject` | `false` | Boolean; rejection is opt-in |
| `rejectedCategories` | `["rude", "abusive"]` | Array of the five labels; replaces, not extends, the default set; `[]` rejects none |
| `endpoint` | `http://localhost:11434/v1/systemone` | HTTP/HTTPS URL without embedded username/password |
| `model` | `d3` | Non-empty model string |
| `timeoutMs` | `5000` | Integer from **1000** to **30000** milliseconds |

Unknown settings, unknown category names, wrong types and invalid endpoints
cause plugin setup to fail rather than being silently ignored. Taxonomy and
classification instructions are fixed; arbitrary classification prompts and
confidence thresholds are not settings.

Enable rejection explicitly, for example:

```json
{
  "plugins": [{
    "package": "/absolute/path/to/opencode-play-nice-plugin/dist",
    "options": {
      "autoReject": true,
      "rejectedCategories": ["rude", "abusive"],
      "timeoutMs": 5000
    }
  }]
}
```

All five judgments are reported, including when rejection is disabled. Blunt
criticism, frustration, profanity and quoted material are intended to be
distinguished from personal attacks; model judgments can still be wrong.
An allowed prompt follows OpenCode's normal provider/tool behavior.

Classification HTTP/transport failures, malformed responses and deadlines
**allow the prompt** with an attempted “classification unavailable” notice.
The overall classification/feedback budget is shared: the default composition
reserves roughly one fifth for feedback instead of letting classification use
the entire budget. This is a bounded operation, not a hard real-time guarantee.

For a rejected judgment, the server waits for a correlated TUI receipt and
then deliberately throws from the pre-admission hook. No cancellation after
admission is used. If toast invocation fails, the TUI disconnects, or a receipt
times out, a **blocked judgment remains blocked**. An allowed/unavailable prompt
is still allowed when feedback fails, with the notification failure logged.

### What a receipt proves

The TUI calls `ui.toast.show`, then sends a per-invocation receipt through the
native location-scoped RPC API. A successful receipt means that API call
returned without throwing. It does **not** prove a rendered frame, visible
pixels, or that the user read the toast. OpenCode's generic rejection/error
toast may immediately replace the tone explanation. The native integration
tests use a headless recording toast, not a PTY or screenshot.

If the event stream ends or fails, the TUI re-subscribes with nonzero, capped
backoff; unload cancels both the subscription and any pending retry. This is
not durable event replay: feedback emitted during a connection gap may still
miss a receipt, and a rejected judgment remains blocked.

Users **edit and resubmit** rejected messages; automatic composer restoration
is not promised. Native API callers should use a new message ID for edited
text: reusing an admitted ID can return the original admission, without
reclassification. Rejection is not a security boundary against other plugins,
synthetic/control messages, shell actions or arbitrary external clients.

## Privacy and model limitations

The plugin sends the **current message text** as the Decision request's
`state`, along with model name, fixed instructions and five criteria. It does
not send conversation history or attachment contents to that endpoint. The
default endpoint is local, but changing it can transmit the text to another
machine; use only a trusted service. Native OpenCode and the chat provider
still manage their own ordinary conversation/history and logging.

Plugin logs contain state transitions, safe error categories, timing and
non-content invocation IDs—not prompts, response bodies, credentials or raw
upstream error text. Decision service and native/provider logs are outside
that plugin logging promise. Test request bodies exist only as test-owned
fixture observations; retained native receipts contain no prompt bodies.

The existing [14-call local qualitative evaluation](.lore/work/research/local-d3-tone-evaluation.md)
is unchanged. It found a notable quoted/task-data false positive: an insult
presented for classification was labeled `rude`, despite the intended quote
distinction. A severe personal insult also fell on the rude/abusive boundary.
That small sample is not an accuracy estimate or a calibrated confidence
guarantee. Automatic rejection stays opt-in; review judgment mistakes rather
than assuming every quoted phrase will be classified correctly.

## Validation

Unit tests use test-owned inputs and mocked dependencies. The following unit,
guard, build and packaging checks do not contact `d3` or start OpenCode:

```sh
bun --no-env-file run test
bun --no-env-file run typecheck
bun --no-env-file run test:native:guards
bun --no-env-file run build
bun --no-env-file run test:package
```

`test` also runs the PN-TERM-1 reconnect regression explicitly through Node,
using the actual pinned client with controlled SSE responses and a recording
toast. It checks recovery after EOF/error, positive bounded retry delays and
unload cancellation without sockets, a native process or a renderer. To run
only that affected suite:

```sh
bun --no-env-file run test:reconnect
```

`test:package` runs the source-export/build-command contract tests, then executes
`node scripts/check-package.mjs` to resolve and load the actual compiled exports.
It requires a successful build first; it does not substitute source for missing
artifacts or run the compiler implicitly. See [Packaging](#packaging).

The assembled integration uses an actual OpenCode 2.2.2 process, the real
default server package and production headless TUI handler, a fake Decision
API with scripted `choice` answers, and a fake chat provider. It does not use a
live Ollama/Decision service or paid provider. An explicitly selected trusted
Linux x64 installation is required; no PATH fallback or auto-install is used:

```sh
OPENCODE_TEST_BINARY=/absolute/installation/.mise/@opencode+cli@2.2.2/node_modules/@opencode/cli/bin/opencode.exe \
  bun --no-env-file run test:native:assembled
```

The installation must include its matching sibling Linux x64 platform package.
The pre-existing `/tmp/opencode` anchor must be trusted/non-linked, and
`/etc/opencode` must be absent. Do not remove host configuration to pass a test.
Each run owns its HOME, XDG directories, DB, config, workspace, HTTP listeners
and process groups; cleanup verifies removal without touching personal services.
See [native test prerequisites and commands](tests/native/README.md), including
the retained boundary/failure cases and full explicit `test:native` command.

## Troubleshooting

- **Plugin missing/failed:** check `/plugins`, the absolute directory, V2 version,
  `plugins` spelling, exports and option types. A `dist` installation requires a
  successful build. Source exports require the native Bun-capable loader, not
  plain Node executing `.ts` as compiled JS.
- **Classification unavailable:** check the configured service/model and its
  `answers.tone.type: "choice"` / valid `choice` response, HTTP outcome and
  timeout. Do not dump private messages or response bodies into diagnostics.
- **Rejected with a generic error:** this is the pinned native throw mapping;
  it can obscure the reason toast. Edit/resubmit, or deliberately disable
  `autoReject` if the current model's mistakes are unacceptable.
- **No tone toast:** ensure the TUI half is active in the same native location.
  A missing receipt does not unblock a rejected judgment. Check safe plugin
  lifecycle/feedback logs rather than interpreting a receipt as visual proof.

## Packaging

`bun --no-env-file run build` runs `scripts/build.mjs`, which invokes the
installed **TypeScript 5.9.3** compiler with `tsconfig.build.json`. It emits only
production `src/` modules as ES2022/NodeNext ESM JavaScript and declarations,
then writes a private `dist/package.json` with compiled `./server`, `./tui` and
`./rpc` export targets and copies the license. It uses existing pinned
dependencies; it neither downloads a compiler nor launches OpenCode.

**`dist/` is generated and replaced on each build.** Do not keep hand-written
files there. The build refuses a linked/non-directory `dist` target, clears old
generated output, fails on compiler errors and checks JS/declaration entrypoint
files before packaging. `typecheck` still uses `--noEmit` and is not a build.
The generated package is for local use alongside this checkout's locked
dependency installation, not a published release or standalone npm archive.

From the checkout root, independent verification must include the real build
and the **compiled manifest's** entrypoint resolution/imports (not root source
imports):

```sh
bun --no-env-file run build
bun --no-env-file run test:package
# Or rerun just the compiled check after a successful build:
node scripts/check-package.mjs
```

The durable `.mjs` entrypoint selects ESM by filename without `--input-type`.
The earlier stdin `node --input-type=module` command failed on Node 26.13 with
`ERR_INPUT_TYPE_NOT_ALLOWED` during dynamic loading: that flag is only valid
for stdin/eval and must not propagate into a file-based loader context. This
was a check-invocation failure, not evidence of a compiled export defect.

The check preserves the pinned V2 `Host.resolve` and `Host.load` calls, requires
each selected entry to be its exact `dist/*.js` file, verifies the compiled
manifest/declaration targets, and actually imports all three emitted modules.
It does not call plugin setup, contact a classifier, or prove native behavior
against `dist`. The existing six assembled native cases still copy source
exports. Keep that evidence distinction when recording final checks or adding
compiled-package native coverage; do not treat their source run as an artifact
run. The replacement compiled-load command has not run in its writer turn.

TypeScript is strict; use explicit typed dependency boundaries and keep native
fixtures separate from production. Dependencies are pinned; use the lockfile
rather than silently upgrading the OpenCode API family.
