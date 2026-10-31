---
title: Decision API choice contract for message tone classification
date: 2026-10-31
status: completed
tags: [decision-api, d3, classification, uncertainty]
modules: [message-classification]
---

# Decision API choice contract for message tone classification

## Key Findings

- The documented local System One contract accepts `model`, `state`, and a `questions` map. A `choice` question takes an `instructions` string and `criteria` map whose option keys are labels and values describe them. The documentation's local endpoint example uses `http://localhost:8000/v1/systemone`; this project targets `http://localhost:11434/v1/systemone` with `model: "d3"` per the supplied working example. No local-runtime documentation located here specifically documents Ollama's host/port or alias behavior.
- A five-way classifier can use labels `kind`, `neutral`, `frustrated`, `rude`, and `abusive`; Choice requires at least two options. A successful answer is keyed by the question id and contains `type: "choice"`, chosen `choice`, `probabilities` for every option, and `confidence`.
- The consulted sources give incompatible confidence definitions. TypeSafe's generic Confidence page defines it as distribution concentration (1 for all mass on one option, 0 for even spread). The local vLLM runtime page instead defines confidence as the winning label's probability over the full vocabulary: its share among labels multiplied by `label_mass`. Do not treat these definitions as interchangeable or silently reconcile them. For planning against the requested local System One-style contract, use the local vLLM runtime semantics, while noting that this documentation does not establish the supplied Ollama endpoint/model alias. The local vLLM docs also say probabilities can vary with batching and prefix-cache behavior.
- The documented failure modes include malformed requests/questions, unsupported or unavailable model, overload/rate limits, and timeout. The user's product requirement is to allow the prompt and show a classification-unavailable notice on failures; that is a product recommendation/requirement, not behavior supplied by the API.
- No documentation found specifies a special abstain/unknown Choice option or a calibrated threshold for this task. Consider retaining the five categories and using low confidence as an uncertainty signal rather than assuming an API-level abstention. Exact thresholds require product policy/evaluation.

## Request shape

Local vLLM's System One page documents the typed request shape and Choice fields. Illustrative request for the stated taxonomy (option descriptions are proposed wording, not API requirements):

```json
{
  "model": "d3",
  "state": "The current message text",
  "questions": {
    "tone": {
      "type": "choice",
      "instructions": "Which category best describes the tone of the current message?",
      "criteria": {
        "kind": "A kind, friendly, or considerate message",
        "neutral": "A neutral or matter-of-fact message",
        "frustrated": "A message expressing dissatisfaction or frustration without abusive language",
        "rude": "A disrespectful or insulting message without abusive content",
        "abusive": "A message containing abusive, threatening, or hateful language"
      }
    }
  }
}
```

Send as JSON with `Content-Type: application/json` to the configured local endpoint `http://localhost:11434/v1/systemone` (endpoint/model pairing supplied by the user). In the published vLLM docs, the local endpoint is shown at port 8000 and the model is a served model name. The API contract shown there does not require authentication for that local example. Do not infer that hosted System One authentication rules apply to local Ollama.

## Response and uncertainty

Representative successful result shape from the local API documentation:

```json
{
  "answers": {
    "tone": {
      "type": "choice",
      "choice": "neutral",
      "probabilities": {
        "kind": 0.01,
        "neutral": 0.91,
        "frustrated": 0.04,
        "rude": 0.03,
        "abusive": 0.01
      },
      "confidence": 0.78
    }
  },
  "model": "d3",
  "usage": {"input_tokens": 100, "output_tokens": 0}
}
```

The numeric values above are illustrative only, not an observed result. Read `answers.tone.choice` as the selected label; inspect the full distribution and `confidence` before applying consequential behavior. For the local vLLM System One contract, Choice probabilities are normalized over supplied options, while confidence is the winning label's probability over the full vocabulary (winning share among labels multiplied by `label_mass`). This conflicts with TypeSafe's generic Confidence page, which defines concentration of the supplied-option distribution. Preserve this source distinction rather than assuming equivalence. Avoid treating confidence as a calibrated probability that the message truly belongs to the category.

For errors, the vLLM System One documentation describes request-level errors as an `error` object with `type`, `code`, and `message`; invalid questions may be returned at the individual question entry in the documented service. The particular D3 alias section notes `/v1/systemone` can fail the whole request when one question fails. Handle transport errors, non-success responses, malformed/missing answer data, and per-question errors as classification unavailable. Product behavior requested here: do not block the prompt; show an unavailable notice. This fallback is a recommendation from product requirements, not an API guarantee.

## Local versus hosted API

The local vLLM documentation provides a localhost endpoint and its own model naming, request/response, and runtime caveats. Hosted Decision API documentation at `decision.vllm-sr.ai` uses the same `/v1/systemone` path but a hosted base URL and API-key authentication. Those hosted policies, limits, logging, and error details should not be assumed for local Ollama. No authoritative Ollama-specific documentation for the supplied `localhost:11434` endpoint/model alias was identified in the consulted sources; retain that as an implementation-context gap.

## Sources

- [vLLM Structured Decisions Models — TypeSafe System One Endpoint](https://docs.vllm.ai/en/latest/models/structured_decisions_models/): local endpoint example, request fields, typed Choice results, probability/confidence semantics, runtime variability, and implementation caveats. Retrieved 2026-10-31.
- [Decision 3.0 API reference](https://decision.vllm-sr.ai/docs): hosted API contract, Choice response example, errors and distinction of hosted endpoint/authentication. This is a separate hosted service, not evidence of Ollama configuration. Retrieved 2026-10-31.
- [TypeSafe Choice primitive](https://docs.typesafe.ai/primitives/choice): conceptual Choice contract (defined options, selected label and distribution). Retrieved 2026-10-31.
- [TypeSafe Confidence](https://docs.typesafe.ai/confidence): defines Choice/Score confidence as a summary of distribution concentration and discusses thresholds. Retrieved 2026-10-31; this definition conflicts with the local vLLM runtime page and is not the planner's contract for the local endpoint.
- User-provided working local Noul example and endpoint/model configuration: `model: 'd3'`, `POST http://localhost:11434/v1/systemone`; treated as supplied context, not independently validated as requested.

## Explicit gaps and guidance

- No documentation located establishes that Ollama exposes or configures this System One endpoint at the supplied port, or defines the `d3` alias there. This was intentionally not probed or runtime-validated.
- No universal confidence cutoff or tone-classification accuracy guarantee is documented. Set any gating threshold as product policy and evaluate separately; do not use confidence alone to justify suppressing a user prompt.
- “Rude” versus “abusive” boundaries are product taxonomy choices; the descriptions above are a starting proposal, not externally sourced definitions.
