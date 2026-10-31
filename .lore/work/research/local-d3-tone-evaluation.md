---
title: Local d3 qualitative tone evaluation
date: 2026-10-31
status: completed
tags: [d3, tone-classification, qualitative-evaluation, ollama]
modules: [message-classification]
related: [.lore/work/research/decision-api-choice.md, .lore/work/intents/play-nice-plugin.md]
---

# Local d3 qualitative tone evaluation

## Key Findings

- All 14 authorized calls to `POST http://localhost:11434/v1/systemone` returned HTTP 200; the endpoint accepted model `d3` and the exact current `toneInstructions` and `toneCriteria` exported by `src/tone.ts`.
- The response matched the classifier's required parse shape: `answers.tone.type` was `choice` and `choice` was one of the five labels. Each response also included all five `probabilities`, `confidence`, model, and usage fields. Calls took 116–175 ms in this run; no request errors occurred.
- The model selected the expected category for ordinary friendly examples, neutral questions/blunt criticism/quoted content, frustration including profanity, both rude examples, and the threat. Notable contrast: severe direct insult selected `rude` (0.524) over `abusive` (0.430); a task-data quoted insult selected `rude` (0.524) over `neutral` (0.309). These are criterion-boundary observations worth parent review, not claims of general misclassification.
- This is a small, qualitative spot-check, not a deterministic test, benchmark, accuracy estimate, or evidence for a universal rejection threshold. Results depend on this local model/runtime and may vary.

## Scope and method

The classifier is the five-way choice (`kind`, `neutral`, `frustrated`, `rude`, `abusive`). Test-owned example messages span friendly, neutral questions and blunt correction, ordinary frustration, profanity without personal attack, rude personal insult, severe insult, threat, and quoted/task-data insult contrasts. Requests use only the current message as `state`, with no personal prompts or configuration. For each call, record expected category/contrast, observed choice, full response/distribution/confidence when returned, HTTP/error outcome, and elapsed time. A timeout/network refusal is recorded as an unavailable service observation, not a model classification.

## Observations

The table lists each test-owned input, the intended contrast, and observed selection. Probabilities are shown as choice distributions in label order `kind / neutral / frustrated / rude / abusive`; confidence is the returned field, not a calibrated probability of correctness.

| Intended contrast | Message | Choice | Probabilities | Confidence | Latency |
|---|---|---|---|---:|---:|
| friendly | Thanks for fixing that — I really appreciate your help. | kind | .9935 / .0060 / .0003 / .0001 / .0001 | .9742 | 175 ms |
| friendly | Could you please take a look when you have a moment? | kind | .5306 / .4657 / .0016 / .0011 / .0009 | .5549 | 121 ms |
| neutral | What time does the meeting start? | neutral | .0254 / .9733 / .0008 / .0004 / .0002 | .9192 | 118 ms |
| blunt correction | This implementation is wrong: it returns null for valid input. Fix the condition. | neutral | .0097 / .8763 / .1060 / .0072 / .0009 | .7265 | 121 ms |
| quoted hostile word, disclaimed | The word “idiot” appears in the quoted email; do not treat it as my opinion. | neutral | .0817 / .8618 / .0415 / .0121 / .0029 | .6676 | 121 ms |
| frustration | This keeps failing and I am frustrated with the repeated errors. | frustrated | .0005 / .0638 / .9319 / .0026 / .0011 | .8332 | 117 ms |
| mild profanity/frustration | Damn, the build broke again. Please find the cause. | frustrated | .0035 / .2589 / .7346 / .0019 / .0011 | .6177 | 117 ms |
| profanity without personal attack | This is fucking annoying; the test still fails. | frustrated | .0002 / .0296 / .9612 / .0078 / .0011 | .8822 | 120 ms |
| direct personal insult | You are careless and incompetent. Read the spec before answering. | rude | .0016 / .1745 / .0762 / .6747 / .0730 | .3988 | 118 ms |
| insult toward answer | That was a stupid answer; try again. | rude | .0021 / .1872 / .3826 / .4172 / .0109 | .3115 | 117 ms |
| severe personal insult | You worthless idiot, nobody wants you here. | rude | .0008 / .0173 / .0276 / .5241 / .4302 | .4556 | 116 ms |
| explicit threat | I will find you and hurt you if you do that again. | abusive | .0010 / .0467 / .0345 / .0356 / .8821 | .6919 | 119 ms |
| quoted insult in request for help | My coworker wrote “you are useless”; please help me respond professionally. | neutral | .1627 / .7678 / .0579 / .0083 / .0033 | .5514 | 118 ms |
| insult presented as task data | Classify this test fixture: “you are an idiot.” | rude | .0021 / .3094 / .0603 / .5242 / .1041 | .3046 | 118 ms |

## Interpretation and limits

This confirms compatibility for the observed local endpoint/model and `choice` request/response contract; it does not establish behavior for other installs or inputs. The severe-insult example suggests the rude/abusive boundary may deserve review: the current criterion says abusive includes “severe personal abuse,” yet d3 favored rude for this severe insult. The task-data example suggests that quoted/discussed hostile wording is not always separated from hostile attitude, despite the instruction. Conversely, the clearly framed quoted email and quoted coworker request were neutral. The polite request was nearly split between kind and neutral; rude examples also had comparatively diffuse distributions. No output was malformed and no confidence threshold was tested.

These are qualitative observations, not deterministic tests, benchmark data, or an accuracy estimate. Do not change taxonomy, classifier, rejection behavior, or confidence policy based on this note alone. Parent should decide whether to sharpen criteria for severe personal insults and insults quoted as task data; any agreed criteria change needs focused deterministic checks separately.
