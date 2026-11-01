---
title: On-demand reflection on Play Nice tone judgments
date: 2026-11-01
status: draft
tags: [intent, play-nice, tone-classification, reflection, local-history]
related: [.lore/work/intents/play-nice-plugin.md]
---

# On-demand reflection on Play Nice tone judgments

## Why this matters

A user can intend to be clear and still have their wording perceived as rude.
An immediate tone score does not explain that gap or help them express the same
request differently. Preserve useful examples so the user can return to them
and ask for an explanation, rather than introducing more unsolicited coaching.

The goal is reflection on particular messages, not judgment of the user's
character or training them to appease the scorer.

## Intended experience

Record messages in the proposed score range between 2 and 3, along with their
scores and enough surrounding context to support a later explanation. This is
selective history for reflection, not a proposal to record every message below
a broad threshold. Storage and the reflection experience remain local, as does
the rest of the plugin; a remote history service is not part of this direction.

Expose reflection through a command, with `/play-nice` as the intended entry
point rather than a separate user-facing skill. For example:

> /play-nice I just had a few turns where I thought I was being clear but were
> seen as rude. Explain why.

A bare `/play-nice` reviews recent recorded turns. Optional text steers the
discussion. The user should not have to identify message IDs before getting
help with the recent exchange.

## What the reflection should do

- Identify the relevant recent messages and explain which wording may have
  sounded hostile, rude, or dismissive, using the available context.
- Distinguish legitimate directness, frustration, and blunt criticism from
  personal hostility. Being clear and being perceived as rude can both be true.
- Offer alternative wording that preserves the user's meaning, urgency, and
  boundaries. Making the request more deferential is not the objective.
- Treat the score as a fallible judgment. Acknowledge when the scorer likely
  overread the tone or the available context does not support a firm conclusion.

Generate the coaching when asked. The retained record supports examination of
the original judgment; it should not turn that judgment into an established
fact about the message or its author.

## Boundaries and open choices

This adds an on-demand reflection path, separate from immediate reporting and
optional rejection. It does not change those behaviors by itself. The earlier
intent's current-message-only classification direction need not prevent a later
reflection from considering surrounding turns.

The proposed capture range is 2–3. Exact endpoint inclusion, the meaning of
that numeric score, and its relationship to the earlier five-category intent
remain to be clarified rather than inferred here.

History lifetime, size limits, clearing controls, how much context to retain,
and whether reflection reaches beyond the current session remain open. Local
storage is settled, not an unresolved deployment choice.

## Useful outcome

After a few uncomfortable turns, the user can ask why their wording was read
as rude and get a grounded explanation, a credible alternative where useful,
and room to disagree with the scorer. No unsolicited coaching is needed to
make this possible.

This records intent only. It does not authorize implementation or settle the
storage design and command integration.
