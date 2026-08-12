# Changelog

## 0.1.0

First release.

- **Floor control** — seven gates between hearing something and saying something,
  with the language model excluded from the decision.
- **Follow-up window** — a reply shortly after the agent speaks counts as
  addressed, so a conversation does not need the wake word every turn.
- **Held questions** — a question refused for timing is answered when the floor
  reopens, and dropped once the room has moved past it.
- **Live notebook** — decisions, action items and open questions extracted while
  the meeting runs, deduplicated across passes, enriched when a later pass
  supplies an owner the first one missed.
- **Spoken commands** — verbatim capture ("that's a decision: …"), mid-meeting
  status ("where are we?"), and off-the-record, which works without the model.
- **Minutes** as Markdown and PDF, titled from the content rather than the room
  code, and refused rather than delivered truncated.
- **Adapters** — Vexa transport; OpenAI, Anthropic, Gemini and local-command
  brains; ElevenLabs, OpenAI, HTTP and silent voices; file, webhook, command and
  memory sinks.
- **`check`** refuses a wake word that collides with ordinary speech.
