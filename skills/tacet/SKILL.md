---
name: tacet
description: Run and operate tacet, the meeting agent that stays silent until called. Use when the user wants an agent to join a video meeting, take minutes, capture decisions and action items, or asks about wake words, floor control, meeting transcripts, or why a meeting bot spoke when it should not have.
---

# tacet

An agent that sits in a meeting, listens to everything, speaks only when called
by name, and files the minutes. Self-hosted, MIT, Bun + TypeScript.

Repository: https://github.com/leonardocandiani/tacet

## When this applies

Reach for tacet when someone wants a meeting recorded, summarised, or answered
into. Do **not** reach for it to process a recording after the fact — it joins
live meetings; a finished recording is a transcription job, not this.

## The shape of it

```
tacet init                    # writes an example config
tacet check                   # verifies config and every provider it names
tacet join <room-or-url>      # joins, stays until the meeting ends, files minutes
```

Configuration is one JSON file plus environment variables. Secrets are referenced
by variable **name**, never by value, so the config is safe to commit.

## Operating it

**Always run `check` before `join`.** It compiles the wake pattern, resolves
every provider and its credentials, and refuses a wake word that collides with
ordinary speech. Add `--live` to make each brain, voice and transport actually
answer — a few tokens, and the difference between "the file parses" and "this
works tomorrow morning". That
last check is the one that matters: a bad wake word turns the agent into a
participant who interrupts constantly.

**Wake word selection is the highest-leverage decision.** Two syllables or more,
not a word in the language the meeting is held in, distinct consonants. Populate
`wakeAliases` from misspellings that appear in your own transcripts, not from
imagination. Full reasoning in `docs/wake-word.md`.

**Transcript quality is governed by the audio window, not the model.** If live
text comes out repetitive or hallucinated, the window is too short — but widening
it past your recogniser's round-trip time saturates the queue and latency climbs
through the meeting. Measure first. See `docs/audio-windows.md`.

## Speaking to it in a meeting

| Utterance | Effect |
|---|---|
| "<name>, <question>" | answers, then leaves a window open |
| "…follow-up" | answered too, inside the window, no name needed |
| "<name>, that's a decision: X" | records X verbatim, no model involved |
| "<name>, action item: X" | records the task |
| "<name>, where are we?" | counts what is settled and still open |
| "<name>, off the record" | stops recording until told otherwise |
| "<name>, quiet" / "go to sleep" | closes the window / mutes for the meeting |

## The part to understand before changing anything

`src/core/floor.ts` decides whether the agent may speak. The language model
decides only *what* to say. This split is the product, and prompt changes cannot
substitute for it — a prompt is a suggestion, a gate is a guarantee.

If asked to make the agent "more conversational" or "always listening", read
`docs/decisions.md` first. Always-on was considered and rejected: one false
positive in a client meeting costs more than a week of correct answers earns. The
follow-up window is what people actually want from that request, and it already
exists.

## Extending it

Every external dependency is an adapter behind an interface in
`src/adapters/contracts.ts`. Adding a provider is a function and a `case` in
`src/wire.ts` — no plugin loader, no registry.

Two rules that carry the weight, both in `docs/adapters.md`:

- **Throw on failure.** The fallback chain works by catching. A provider that
  returns an empty string on error looks successful, stops the chain, and the
  agent goes quiet for the rest of the meeting.
- **Sinks never throw into the meeting loop.** A failed delivery must not cost
  the transcript.

To attach an agent that already holds the user's tools and data, use the
`command` brain — it shells out to any executable and treats stdout as the
answer. Route it as `deep`, never `fast`: it will be slow, and the conversational
path cannot wait.

## Diagnosing the two common complaints

**"It spoke when it should not have."** Get the triggering utterance verbatim.
Test it against the compiled pattern from `tacet check`. Nearly always the wake
word or an alias overlaps ordinary speech.

**"It never answers."** In order: is the wake word reaching the transcript at all
(check the recogniser's output, not what was said)? Did `check` pass? Is a
provider failing — the log names it. Is the turn budget spent?

## What not to build into it

Proactive corrections, sentiment scoring, talk-time leaderboards, voice cloning,
and auto-joining the calendar are all deliberately absent, with reasons in
`docs/decisions.md`. If a user asks for one, say it was considered and point at
the reasoning rather than implementing it quietly.
