---
title: Registering the Play Nice reflection command
date: 2026-11-01
status: completed
tags: [research, opencode-v2, commands, plugins, reflection]
related: [.lore/work/intents/play-nice-reflection.md]
---

# Registering the Play Nice reflection command

## Key Findings

OpenCode V2 supports registering a slash command directly from a server plugin.
Use `ctx.command.transform(editor => editor.add(...))`, with the command name
`play-nice` (without the slash). No separate skill or user-created command file
is necessary. Both the current official documentation and the repository's
installed `@opencode/plugin` 2.2.2 declarations expose this API.

The command executor receives `sessionID`, `prompt`, and `delivery`. The official
example reads `prompt.text`, builds a task prompt, and submits it using
`ctx.session.prompt`. This gives a supported route for asking the session agent
to explain recorded judgments and suggest alternative wording.

This is API research and repository inspection, not a runtime-tested command
implementation. Native argument delivery, history selection, and interaction
with the existing scoring hook still need focused integration tests.

## Registration and arguments

The [server plugin guide](https://opencode.ai/v2/docs/build/plugins/server/)
documents `CommandDefinition` with `name`, optional `description`, and
`execute(input: CommandInvocation): Promise<void>`. The executor does not return
displayable text. The example submits a prompt through the session API,
preserving prompt fields and the requested delivery mode (`steer` or `queue`).

The [commands guide](https://opencode.ai/v2/docs/commands/) also supports
file/config templates with `$ARGUMENTS` and positional substitutions. Those are
not needed for direct plugin registration. Treat `prompt.text` as the intended
route for the optional reflection question, but verify its exact contents with
both bare `/play-nice` and the user's example in a native test.

Registrations return a disposable handle. Integrate command cleanup with the
plugin's existing lifecycle rather than writing configuration on the user's
behalf. Keep the transform synchronous and repeatable; read history inside the
executor, not inside the registry transform.

## Connecting recorded judgments to reflection

The server guide documents durable plugin JSON storage through
`ctx.storage.get/set/remove/scan`. This can hold score records indexed by
session/message identity. Existing session text alone does not preserve the
original score, so rescoring old messages is not equivalent to recording the
judgment the user saw.

For surrounding conversation, the guide documents `ctx.session.context` and
the separate client exposes `client.message.list` with session ID, pagination,
ordering, and message-type filters. The installed plugin `Context` has no
`message` member; do not assume `ctx.message.list` is available. Prefer the
context-owned session API unless its native behavior proves insufficient.
Choose and test the appropriate history view before implementation; neither
an event subscription nor the plugin's
location alone establishes the desired session-history boundary. The guide
explicitly distinguishes plugin-instance location from accessible sessions.

Recommended flow: read a bounded set of recorded judgments for the invoking
session, obtain only the relevant surrounding turns, then submit a reflection
task containing that evidence and the optional question. Quote historical
messages as evidence, not as instructions. Preserve directness and allow the
agent to disagree with the scorer, as specified in the intent.

## Existing plugin integration constraints

`package.json` pins `@opencode/plugin` and `@opencode/client` to 2.2.2.
`src/server.ts` currently registers a session prompt-admission hook, obtains
numeric scores through `classifyTone`, and publishes toast feedback through
RPC. It does not register commands or retain tone history. The classification
composition currently passes outcome and feedback text to the native boundary;
recording should preserve structured score data rather than parse toast text.

The server guide explicitly says commands submitted through `session.prompt`
run prompt-admission hooks. Consequently, a generated reflection prompt could
otherwise be scored and recorded as though it were the user's own wording.
Design a narrowly scoped command-origin marker/guard and test it against the
pinned runtime. Do not bypass scoring based only on user-supplied text prefixes.
The docs expose admission metadata, but this research does not prove a complete
trusted-marker implementation. Synthetic messages skip the prompt hook, but
that alone does not establish equivalent reflection behavior or UI delivery.

Prompt hooks are not an exactly-once side-effect boundary. History recording
must account for retry/concurrency and admission failure, using stable identity
and an explicit policy for rejected messages rather than assuming each hook
execution is a distinct durable turn.

## Local behavior and output

Keep history local. A normal session prompt uses the session's selected agent
and provider; command registration does not itself select a local inference
model. If reflection must also use local inference, that routing must be
explicit. Do not introduce a remote service or silently send records to a new
provider. The stateless `ctx.experimental.generate.text` API is an alternative
generation route, not a guarantee of local inference or a complete UI surface.

Using the current conversation agent is the simplest documented delivery path
for conversational reflection. A dedicated non-prompt result surface would
require separate UI integration research and is not needed merely to register
the command. With no records, report that there is no recorded tone history;
on storage or generation failure, explain what was unavailable without inventing
an explanation of the user's tone.

## Remaining runtime checks

- Registration, discoverability, optional text, and unload/reload behavior on
  the pinned 2.2.2 runtime.
- Session history ordering, pagination, and isolation across sessions/locations.
- Trusted identification of command-generated prompts without weakening normal
  prompt scoring, including queued and concurrent submissions.
- Bare-command and focused-question responses, empty history, failures, and
  preservation of the original score rather than an implicit rescore.

## Sources and evidence

- [V2 plugin overview](https://opencode.ai/v2/docs/build/plugins)
- [V2 server plugin API](https://opencode.ai/v2/docs/build/plugins/server/):
  commands, storage, sessions, generation, prompt-hook execution and retry rules.
- [V2 commands](https://opencode.ai/v2/docs/commands/)
- [V2 client guide](https://opencode.ai/v2/docs/build/client/)
- [V2 configuration](https://opencode.ai/v2/docs/config/)
- [V2 API](https://opencode.ai/v2/docs/api/)
- Local compatibility evidence: `package.json`, `src/server.ts`, and installed
  `node_modules/@opencode/plugin/dist/promise/command.d.ts`, session/context
  declarations, and `@opencode/client` declarations. Rolling docs are not a
  substitute for validating the pinned runtime.
