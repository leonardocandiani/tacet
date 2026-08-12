# Audio windows, and why transcript quality is not about the model

If live transcription comes out repetitive, hallucinated or garbled, the instinct
is to reach for a bigger model. That is usually the wrong lever. The window is
the lever.

## The evidence

A meeting was transcribed live and came out unusable: fragments repeating, phrases
appearing that nobody said. The same audio, recorded and transcribed afterwards in
one pass with the *same model*, came out coherent.

Same model, same audio, different result. The only variable was chunking.

Live, the bot was submitting windows of one to three seconds. Whisper-family
models are trained on ~30-second context and behave badly when starved of it:
starved of context, they repeat the previous phrase or invent filler. Raising the
window to four seconds returned whole sentences, at a median delay of 5.7 seconds
end to end.

## The trade

A longer window means better text and a later answer. Where you sit depends on
how fast your recogniser is:

| Recogniser | Speed | Usable window |
|---|---|---|
| Hosted Whisper (Groq and similar) | ~0.5 s per call | 4–6 s comfortably |
| Local `large-v3-turbo` on CPU | ~5 s per call, roughly fixed | 2–3 s, and the queue saturates |

That second row is the trap. With a fixed ~5-second cost per call, a 4-second
window means the queue grows faster than it drains, and observed latency climbs
from 14 seconds to 32 as the meeting goes on. It looks like a network problem. It
is arithmetic.

Measure your recogniser before widening the window:

```bash
time curl -s -X POST "$STT_URL/audio/transcriptions" \
  -H "Authorization: Bearer $KEY" \
  -F file=@sample.wav -F model=whisper-large-v3-turbo -F response_format=verbose_json \
  >/dev/null
```

If that number is comfortably below your window, widen it. If it is close to it,
the window is already too wide.

## Never seed vocabulary into the prompt

Whisper-compatible APIs accept a `prompt` that biases recognition. On a clean
recording, seeding it with your product names measurably improves them.

Do not do it on live audio.

During silence, the model recites the prompt back as if it were speech. Those
recitations enter the transcript attributed to whoever spoke last, and they look
exactly like something a person said. A transcript with invented sentences is
worse than one with misspelled product names, because the misspelling is visibly
wrong and the invention is not.

Fix terminology *after* recognition instead, with `corrections` on the
transcriber adapter:

```ts
groqTranscriber({
  apiKey: process.env.GROQ_API_KEY,
  corrections: [[/\bmosqui?t\w*\b/gi, 'Moskit']],
})
```

Keep that list short. Every entry is a chance to corrupt correct text, so only
add a pattern whose wrong form is not a real word in the language being spoken.

## Hallucinated silence

Whisper fills silence with subtitle boilerplate it learned from its training set:
"Subtitles by the Amara.org community", "Thanks for watching", "Subscribe to the
channel". These arrive looking like speech and get attributed to a participant.

`COMMON_HALLUCINATIONS` in `src/adapters/transcribers.ts` drops the usual set at
the source. Add to it when you see a new one — they are language-specific, and the
list shipped here is English.
