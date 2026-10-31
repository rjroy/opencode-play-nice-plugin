---
title: OpenCode prompt hooks for message tone feedback and rejection
date: 2026-10-31
status: completed
tags: [opencode, plugins, prompt, hooks, moderation]
modules: [plugin]
---

# OpenCode prompt hooks for message tone feedback and rejection

## Key Findings

- **Stable v1 docs do not document `chat.message` or `experimental.chat.messages.transform`**: neither is in the current stable plugin hook/event list. The available stable docs therefore do not establish a v1 plugin hook for inspecting/rejecting user prompt text.
- **Current v2 docs do document prompt admission interception** via `ctx.session.hook("prompt", callback)`: it receives a mutable user-prompt draft before attachment/skill resolution and durable inbox admission. It runs before the normal model/agent processing path, but docs explicitly say it has no typed rejection API. A blanket claim that an exception is a supported hard-rejection mechanism is not documented.
- **Short UI feedback is documented**: v1 SDK docs show `await client.tui.showToast({ body: { message, variant } })` returning `boolean`; v2 TUI plugin docs show `context.ui.toast.show({ title?, message, variant, duration })`. These establish toast APIs/examples, not their delivery guarantees or a feedback method available from the v2 server hook context.
- **Target baseline is now OpenCode 2.2.2**, with its plugin family `@opencode/plugin` / `@opencode/client`, not V1. The supplied [2.2.2 validation report](opencode-2.2.2-validation.md) gives pinned external-client evidence for asynchronous durable admission, `resume: false`, inbox cancellation before delivery, and best-effort interruption. It expressly does not validate plugin rejection semantics.
- Stable docs document a separate `tool.execute.before(input, output)` hook and demonstrate throwing an error to prevent a tool from executing. That is **tool execution**, not evidence that a user prompt can be rejected before the agent acts.
- The docs show async plugin hooks and a `client` SDK client, but do not define user-message hook async timing, cancellation/error propagation, retry/edit behavior, or a plugin-specific enable/disable configuration toggle.
- OpenCode v2 is a distinct API line (`@opencode/plugin`); V1 plugin implementations do not run in V2. The v2 `prompt` admission hook, rather than its `context` model-request hook, is the relevant interception point. `context` runs immediately before model dispatch, but is downstream of admission and is intended to modify model-visible request material.
- For the intended local d3 Decision API classification, a safe design recommendation is to fail open on Ollama/classification errors, show an unavailable notice if a supported UI surface is established, and let the user edit/resubmit after opt-in blocking. Those are project requirements/recommendations, **not guarantees supplied by the retrieved OpenCode docs**.

## Version-specific 2.2.2 context

The user-supplied [OpenCode 2.2.2 integration validation](opencode-2.2.2-validation.md) reports baseline versions `@opencode/client@2.2.2`, `@opencode/cli@2.2.2`, and official source tag `v2.2.2` at commit `098aa7fd6e02b03d6fc410f0b052038c7d4c5e81`. Treat it as existing, user-supplied external-client validation evidence, not newly retrieved docs and not proof of plugin hook behavior. In particular it explicitly characterizes `session.prompt` as durable asynchronous inbox admission returning an admitted record, not completed generation; `resume: false` admits without starting generation; `session.inbox.cancel` removes undelivered input; `session.interrupt` is best effort. It cautions against treating prompt IDs as permanent tombstones or assuming exactly-once behavior. This does not establish that a plugin can safely cancel an input after admission, nor substitute for admission gating.

The current official [V2 server plugin reference](https://opencode.ai/v2/docs/build/plugins/server/) and [V2 API reference](https://opencode.ai/v2/docs/api/) are the relevant API-family documentation pages found. The V2 API page is a live OpenAPI reference and does **not** identify its schema as 2.2.2; do not silently project its present endpoint details onto the pinned baseline. Its prompt operation currently says it durably admits input and schedules agent-loop execution unless `resume` is false; inbox cancel currently describes cancellation of not-yet-delivered input and unavailable-item no-op. These are useful distinctions, but the supplied 2.2.2 report—not current live API docs—is the version-specific source for the listed baseline behavior.

The server plugin reference retrieved here is also not tagged to a release. It documents the V2 prompt hook and its admission-stage timing, but the page's applicability to precisely 2.2.2 is not declared. The supplied report establishes the 2.2.2 public client/inbox behavior, not that exact plugin hook shape. Record this compatibility gap explicitly rather than re-running experiments or inspecting source.

### Documented contract vs proposal at 2.2.2

| Topic | Evidence and status |
|---|---|
| Inspect user input before model work | Current V2 plugin docs: `ctx.session.hook("prompt", callback)` receives mutable draft before attachment/skill resolution and durable admission. For 2.2.2 specifically, exact matching plugin hook contract is not established by the supplied report or version-tagged docs retrieved here. |
| Await classification before admission | V2 reference allows callback return `Promise<void> | void`, and says preparation failure/interruption means no admission; it does not expressly define await/error propagation. This suggests async classification as a proposal, but does not fully document whether the hook awaits the returned Promise or how its rejection is surfaced. |
| Hard block rude/abusive | No documented typed rejection API; no release-specific guarantee that throwing from the hook is a supported policy rejection. Do not claim guaranteed blocking on the basis of `session.inbox.cancel` or `session.interrupt`: those act after/around admission, and the supplied 2.2.2 report says cancellation concerns undelivered inbox items while interruption is best effort. |
| User feedback | V2 TUI docs show toast and prompt-footer UI in the TUI plugin context. V2 server docs do not expose that UI in the server hook context or document a server-to-TUI notification path. V1 SDK `client.tui.showToast` is from a different API family and is not evidence of a 2.2.2 server-plugin contract. |
| Ollama failure and resubmit | Fail-open/unavailable notice and edit/resubmit remain product recommendations. Retrieved official docs do not specify how prompt-hook failure is presented or how an unadmitted prompt is restored in the composer. |

Avoid proposing replacement of the native plugin with an external `@opencode/client` wrapper: the supplied report validates that client's admission/cancellation primitives for an application integration, not a substitute for the requested plugin behavior.

## Stable v1 plugin surface and SDK

The [official Plugins documentation](https://opencode.ai/docs/plugins/) says plugins are JavaScript/TypeScript modules whose plugin function receives context and returns hooks. It lists `tui.prompt.append`, `tui.toast.show`, and message lifecycle events, but supplies no signatures or event-specific descriptions for these. It does not list `chat.message` or `experimental.chat.messages.transform`. The related [SDK reference](https://opencode.ai/docs/sdk/) documents SDK endpoint methods rather than a `Plugin` hook reference. Thus no supported stable v1 pre-agent user-prompt admission hook was established from these official stable references.

The same page demonstrates `tool.execute.before: async (input, output) => { ... }`; its `.env` example throws `new Error(...)` to prevent that tool operation. The documented target is specifically a tool (`input.tool === "read"`), not prompt submission. Throwing there cannot be extrapolated to message rejection.

The SDK reference provides a concrete short-feedback method: `await client.tui.showToast({ body: { message: "Task completed", variant: "success" } })`, with `boolean` response. It does not document the full body schema, allowed variants, duration, defaults, transport/delivery timing, or guarantee that every plugin context has an attached TUI. This is an SDK method example, not proof it is safe to invoke from any hook/context. SDK HTTP error handling (`result.error` by default, or throwing with `throwOnError`) applies to SDK requests and does not define plugin hook failure semantics.

## V2 prompt admission, model request, and TUI feedback (separate API)

The [V2 migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1/) explicitly maps the V1 `chat.message` hook to V2 `ctx.session.hook("prompt", ...)` and maps `experimental.chat.messages.transform` to `ctx.session.hook("context", ...)`. These are migration destinations, not exact renames. It states `prompt` runs before durable prompt admission, whereas `context` runs immediately before an agent model request. V1 implementations do not run in V2. The [V2 overview](https://opencode.ai/v2/docs/build/plugins/) distinguishes this API from stable V1.

The [V2 server plugin reference](https://opencode.ai/v2/docs/build/plugins/server/) documents the prompt hook as:

```ts
await ctx.session.hook("prompt", (event) => {
  event.prompt.text = event.prompt.text.replaceAll("company-secret", "[redacted]")
  event.delivery = "queue"
})
```

`event.prompt` is an owned mutable draft: `text`, `files`, agent mentions in `agents`, and selected `skills`; event also has application-defined `metadata` and `delivery` (`"steer"` default or `"queue"`). Session/message IDs are readonly; admission cannot be redirected. Files/skills follow normal resolution. Commands using `session.prompt` invoke it; synthetic, shell, compaction-control, and move-control messages do not. It runs once during admission, after location plugins are ready, before attachment and skill resolution and durable inbox admission; edits become canonical persisted user input.

The server reference gives the generic registration signature (but not the full `SessionPrompt` declaration):

```ts
interface SessionHooks { prompt: SessionPrompt }
interface SessionHookContext {
  hook<Name extends keyof SessionHooks>(
    name: Name,
    callback: (event: SessionHooks[Name]) => Promise<void> | void,
    options?: Name extends "prompt" ? never : { providerID?: string },
  ): Promise<Registration>
}
```

It identifies the type import as `import type { SessionPrompt } from "@opencode/plugin/promise/session"`. Docs allow a promise-returning callback, but the retrieved reference does not explicitly say the callback is awaited or define what a thrown/rejected callback does. Critically, the reference says prompt hooks **“do not expose a typed rejection API”**; if preparation fails or is interrupted OpenCode does not admit the prompt. This supports a documented pre-admission interception point and a general preparation-failure outcome, but does not promise that throwing is a supported/reliable policy rejection or describe the user-visible error, cancellation, retry, or edit flow. It warns that retries of an already pending/delivered ID return original admission without rerunning hooks, while concurrent submissions may run multiple times and only the first successful admission wins.

The `context` hook is a different stage: it mutates assembled system/messages/tools/options immediately before model dispatch and changes the outgoing model call, not persisted history/config. It runs for agent-loop requests; other request kinds have separate hooks (`compaction`, `generate`, `title`). The docs do not describe it as an admission/rejection API.

The [V2 TUI plugin reference](https://opencode.ai/v2/docs/build/plugins/cli/) documents `context.ui.toast.show({ title?, message, variant, duration })` and a prompt-footer slot such as `context.ui.slot({ append: "prompt.footer.status", render: ... })`. It does not specify allowed variants, duration units/defaults, or a dedicated feedback contract tied to prompt admission. These APIs are in the separate TUI plugin context; the server prompt-hook docs do not show `context.ui` there. A server-to-TUI feedback path therefore remains unspecified by these pages.

| Hook | Documented contract | Relevance / limit |
|---|---|---|
| `ctx.session.hook("prompt", callback)` | Mutable prompt draft before attachment/skill resolution and durable admission | Appropriate documented user input inspection point. No typed rejection API; failure/interruption prevents admission, but throw-as-policy-rejection details and visible cancellation outcome are unspecified. |
| `ctx.session.hook("context", callback)` | Mutable assembled request immediately before model dispatch | Model-request transformation, not prompt admission; do not use as evidence of rejection. |
| `ctx.tool.hook("execute.before", callback)` | Tool input before selected tool execution | Tool boundary only, not user prompt gate. |

Hooks run in registration order and later hooks see earlier changes. Async callback type is `Promise<void> | void`; exact awaiting and exception propagation are still undocumented in the retrieved text.

The user-suggested V1 hook names `chat.message` and `experimental.chat.messages.transform` are not in the official stable V1 plugin page's documented event list. The V2 migration guide uses them as V1-to-V2 migration keys, mapping them respectively to `prompt` and `context`; it does not provide their V1 V1 callback signatures or V1 runtime behavior. The V2 guide explicitly cautions that mappings are not always exact renames.

## Configuration

In stable docs, local plugins load from `.opencode/plugins/` or `~/.config/opencode/plugins/`; npm plugins are listed in the `plugin` array in `opencode.json`, e.g. `"plugin": ["@my-org/custom-plugin"]`. See [Plugins](https://opencode.ai/docs/plugins/) and [Config](https://opencode.ai/docs/config/). No hook-specific toggle or documented setting for enabling this behavior appears in the retrieved config material. The proposed “auto-rejection opt-in” should therefore be treated as an application/plugin setting whose storage/UI contract remains to be designed, not an OpenCode core setting documented here.

## Planning implications and unknowns

1. The project target is 2.2.2 V2 API family; do not frame this as a v1-vs-v2 product decision. `ctx.session.hook("prompt", ...)` is the current documented V2 pre-admission inspection point, but its exact contract at 2.2.2 remains version-attribution limited.
2. V2 docs establish non-admission when preparation fails/is interrupted, but expressly lack typed rejection API and do not specify thrown-error/user-visible behavior. A hard block must not be promised based solely on throwing. Post-admission inbox cancellation and interruption are not equivalent to a pre-admission gate.
3. For feedback, current V2 TUI docs provide a toast API in the TUI plugin context; no server-to-TUI communication path from prompt hook was found. V1 SDK toast docs should not be used to establish a 2.2.2 server-plugin contract.
4. Keep the local Ollama fail-open/unavailable notice and edit/resubmit behavior as product requirements/recommendations; OpenCode docs do not specify those flows.

## Sources

- [OpenCode Plugins (stable docs)](https://opencode.ai/docs/plugins/) — plugin loading, context, event list, tool-before example, logging, compaction.
- [OpenCode SDK (stable docs)](https://opencode.ai/docs/sdk/) — generated client and `tui.showToast` example/response; retrieved 2026-10-31.
- [OpenCode Config](https://opencode.ai/docs/config/) — plugin array and configuration locations.
- [OpenCode v2 Plugins overview](https://opencode.ai/v2/docs/build/plugins/) — V2 package/API distinction.
- [Migrate plugins from V1](https://opencode.ai/v2/docs/build/plugins/migrate-v1/) — hook mapping, before-admission vs before-model timing, version incompatibility; retrieved 2026-10-31.
- [V2 Server plugin reference](https://opencode.ai/v2/docs/build/plugins/server/) — prompt admission, hook timing/shape, async callback type, rejection limitation, retry/interruption notes; retrieved 2026-10-31.
- [V2 TUI plugin reference](https://opencode.ai/v2/docs/build/plugins/cli/) — `context.ui.toast.show`, prompt footer slots, distinct TUI context; retrieved 2026-10-31.
- [V2 API reference](https://opencode.ai/v2/docs/api/) — current live OpenAPI endpoint descriptions for durable prompt admission, inbox list/cancel, and interruption; not explicitly tagged 2.2.2; retrieved 2026-10-31.
- [.lore/work/research/opencode-2.2.2-validation.md](opencode-2.2.2-validation.md) — user-supplied existing report for 2.2.2 external-client/native integration findings; not plugin rejection proof and not repeated/validated in this documentation pass.

## Research boundaries

Documentation retrieval and recording only, as of 2026-10-31. No tests, runtime experiments, source-code review, or installed-package verification were performed. SDK/OpenAPI types establish declared shapes, not behavior beyond explicit documentation. The V2 prompt hook is documented in current docs, but its precise 2.2.2 compatibility, awaited/rejected promise behavior, supported hard rejection semantics, and server-to-TUI feedback transport remain gaps. The supplied 2.2.2 report is treated as historical evidence only and its experiments were not repeated. Missing contracts are not inferred from names or analogous hooks.
