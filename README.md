# Play Nice for OpenCode

Play Nice is a private, unreleased plugin for OpenCode 2.2.2 V2. It scores the
tone of the current user message, attempts to show the result, and can optionally
reject a message before admission. It judges wording, not character. You can
also ask it to reflect on selected past evaluations in the current session.
Play Nice skips scoring and rejection for sessions it identifies as child
sessions. If the session lookup fails or times out, normal classification and
rejection still apply.

The package is built from this checkout, not installed from npm. Source-package
native tests use a fake Decision service and a fake chat provider. They do not
prove a visible TUI toast or native behavior of the compiled package.

## Requirements

- OpenCode 2.2.2 V2. V1 plugin APIs are not compatible.
- Bun 1.4.3 and the dependencies pinned in `bun.lock`. Building and the
  Node-hosted checks also need Node 22.15+ in the 22.x line, Node 24.x, or Node
  26 or newer.
- A separately running Decision API compatible with the Score request. The
  defaults target `http://localhost:11434/v1/systemone` and model `d3`. This
  project does not install the service, download the model, or start either one.
  The endpoint must accept a JSON POST with `model`, `state`, and a `tone` score
  question, and return a finite 0 to 4 score in `answers.tone.score` with
  `answers.tone.type` set to `score`.

## Quick start

From a trusted checkout, install the pinned dependencies and build the package:

```sh
bun --no-env-file install --frozen-lockfile
bun --no-env-file run build
```

Merge this entry into your workspace's `opencode.json` or `opencode.jsonc`.
Replace the example path with the absolute path to this checkout's `dist`
directory, and adjust the endpoint and model if your Decision service differs.
Keep any existing plugins and settings.

```json
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-play-nice-plugin/dist",
      "options": {
        "endpoint": "http://localhost:11434/v1/systemone",
        "model": "d3"
      }
    }
  ]
}
```

Use the package directory, not `dist/server.js`. Start OpenCode in the workspace
and check `/plugins` for Play Nice. Send a message to try scoring. Rejection is
off by default. Use `/play-nice` after an eligible evaluation to request
reflection. Feedback uses the TUI, but a successful toast API call does not
guarantee that a toast was rendered or read.

## Scores and feedback

The scale is **0 abusive, 1 rude, 2 frustrated, 3 neutral, 4 kind**. Scores
may be fractional. They represent a position on the scale, not confidence or a
verdict about the author. The feedback displays the score to two decimal places
and the nearest label, with halfway values rounded toward the higher label.
Model judgments can be wrong, including when text contains quotes or criticism.

By default, scored messages are allowed. With `autoReject: true`, the plugin
compares the unrounded score with `rejectBelowScore` and rejects scores strictly
below it. At the default cutoff, 1.49 is rejected and 1.5 is allowed. Edit and
resubmit a rejected message. Automatic composer restoration is not promised.

If classification times out, fails, or returns an invalid score, the prompt is
allowed and the plugin attempts to report that classification was unavailable.
Feedback failures do not turn a blocked decision into an allowed one. An
allowed decision does not prove that OpenCode later admitted the message.
Feedback receipts acknowledge a TUI API call, not visible pixels, and a generic
native error may obscure a rejection notice. Rejection is not a security
boundary against other plugins or other ways to interact with OpenCode.

## Reflect on tone

- `/play-nice` reviews recent recorded evaluations in this session.
- `/play-nice Why might that sound dismissive?` focuses the review on a question.
- `/play-nice clear` removes the current session's Play Nice records. Only the
  exact argument `clear` performs this action.

The plugin records evaluated attempts with scores from **2 through 3**,
inclusive, including rejected attempts. It stores the original wording,
fractional score, time, session and message IDs, scoring model, and policy
outcome. This range is selected evidence, not proof that the wording was rude.
Reflection asks the session agent to consider the evidence and available recent
context, suggest alternatives that preserve intent, and allow for scorer error.

The store is local to the plugin location. It retains at most 200 records per
location and reflection selects at most the latest 10 for the current session.
Records older than 30 days and excess records are pruned on a history read or
write. An inactive store can therefore retain expired records until the next
access. Clearing these records does not erase OpenCode's conversation history.
If no records are available or history cannot be accessed, the plugin attempts
to report that without starting a reflection request. A history write failure
does not change the scoring policy's allow or reject decision.

## Configuration

Place options in the plugin entry shown above. Omitted values use these defaults:

| Option | Default | Accepted values |
| --- | --- | --- |
| `autoReject` | `false` | Boolean |
| `rejectBelowScore` | `1.5` | Finite number from 0 to 4, inclusive |
| `endpoint` | `http://localhost:11434/v1/systemone` | HTTP or HTTPS URL without embedded username or password |
| `model` | `d3` | Nonempty, non-whitespace string |
| `timeoutMs` | `5000` | Integer from 1000 to 30000 milliseconds |

For example, add `"autoReject": true` to the `options` object to enable
rejection. `rejectBelowScore` only affects enforcement when rejection is on.
The timeout is a shared operation budget, not a hard real-time guarantee.
Unknown or invalid options fail setup. The former `rejectedCategories` option
is not supported; use `rejectBelowScore` instead.

## Privacy

Scoring sends the current message text, fixed scoring instructions, criteria,
and model name to the configured Decision endpoint. It does not send the
conversation history or attachment contents to that endpoint. The default
endpoint is local; a different endpoint can send text to another machine.

Reflection history is stored locally, but reflection uses the current session's
agent and provider, which may be remote. The selected records and available
recent context are sent to that provider when you request reflection. OpenCode,
the Decision service, and the chat provider manage their own history and logs.
Play Nice's operational logs omit prompt text and raw upstream errors.

## Troubleshooting

- **Plugin missing or failed:** Check `/plugins`, the absolute package directory,
  OpenCode version, `plugins` spelling, and option values. Build before pointing
  the configuration at `dist`.
- **Classification unavailable:** Check that the configured service is running,
  the model is available, the endpoint accepts the Score request described above,
  and its response has a valid score. Check the timeout without sharing private
  message text or response bodies in diagnostics.
- **No feedback toast:** Check that the TUI side is active in the same location.
  Delivery or receipt can fail; a blocked judgment remains blocked even then.
- **Reflection unavailable or empty:** Check that this session has evaluated
  attempts in the 2 to 3 range and that plugin storage is available. Other
  sessions' records are not included.

## Packaging

`bun --no-env-file run build` compiles production TypeScript into `dist/` and
creates a private package manifest with `./server`, `./tui`, and `./rpc`
exports. `dist/` is generated and replaced by each build. Do not put hand-written
files there. The built package is for local use alongside this checkout and its
locked dependencies, not a standalone published archive.

For development, the checkout root also exports those names as source
TypeScript. Configure either the root source package or `dist/`, not both.
Source loading requires a compatible native loader. See [contributing](CONTRIBUTING.md)
for checks and [native test instructions](tests/native/README.md) for the
explicit opt-in integration fixture and its limits.
