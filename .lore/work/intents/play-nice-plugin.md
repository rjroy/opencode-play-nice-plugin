---
title: Play Nice OpenCode plugin
date: 2026-10-31
status: draft
tags: [intent, opencode, tone-classification, ollama, system-one]
---

# Play Nice OpenCode plugin

Create an OpenCode plugin that monitors what the user says to the agent and
gives feedback about whether they are “playing nice” or “being mean.” It judges
the tone of a message, not the user's character.

## Intended experience

The plugin evaluates user prompts with a System One Decision model, such as
`d3`, served through Ollama. Feedback makes the tone judgment visible to the
user. The plugin can also be configured to automatically reject prompts judged
mean instead of allowing the agent to act on them.

Configuration should offer useful control without becoming infinitely
customizable. The user selected five model tone judgments rather than five
strictness presets, using the `choice` primitive:

- **Kind**
- **Neutral**
- **Frustrated**
- **Rude**
- **Abusive**

These are message classifications, not five separate models or user-selectable
personas. The proposed configuration lets users choose which judgments trigger
rejection; the exact controls and defaults remain to be settled. Reporting tone
and enforcing rejection are distinct behaviors.

## Agreed starting defaults

- Classify only the current user message.
- Report all five judgments. When auto-rejection is enabled, reject rude and
  abusive messages by default; automatic rejection is opt-in.
- If Ollama fails, allow the prompt and report that classification was unavailable.
- Keep feedback brief and let users edit and resubmit rejected prompts.
- Define category examples so frustration and blunt criticism are not
  automatically treated as abuse.

## Still to settle

- The definitions and examples that distinguish the five judgments, including
  blunt criticism, profanity, quoted material, and frustration without insults.
- Which judgments count as “mean” for feedback, and the exact configuration
  controls for changing rejection behavior.
- How brief feedback appears in OpenCode.
- How an invalid or uncertain model judgment is handled.
- The concrete model identifier, primitive contract, and OpenCode hook support.
  The intended integration has not yet been technically verified.

## Local API evidence

The user successfully tested `d3` with
`POST http://localhost:11434/v1/systemone`, sending JSON with `model`, `state`,
and a named `questions` map. A greeting question used `type: "noul"`,
`instructions`, and `criteria` with `true` and `false` descriptions. The response
contained `answers.says_hello.type: "noul"` and a numeric
`answers.says_hello.noul` value of `0.9971171486547835`, plus token usage.

This is user-reported evidence that the local Decision API works for `noul` with
`d3`, not a plugin integration test. The plugin should use the same local API
with a five-option `choice` question; its exact request and response contract
still needs checking against the Decision API documentation.

## Useful outcome and scope

A useful result gives users understandable tone feedback during normal OpenCode
use and supports optional automatic rejection under a bounded configuration.
It should distinguish the five judgments meaningfully rather than treating all
non-kind messages as equally mean.

This records product direction. It does not select implementation details or
authorize implementation.
