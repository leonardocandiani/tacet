# Choosing a wake word

The name you give the agent is not branding. It is the input to a regular
expression that runs against machine-transcribed speech, and getting it wrong
produces one of two failures, both bad.

## Failure one: it never wakes

Speech recognisers mangle proper nouns, and they mangle them consistently. If the
name only matches its correct spelling, the agent sits silently through every
attempt to call it while the transcript fills with near-misses.

The fix is `wakeAliases`, and the right way to populate it is from your own
transcripts rather than imagination:

```bash
grep -oiE '\b\w*(the sound you expect)\w*\b' meetings/*/minutes.md | sort | uniq -c | sort -rn
```

Add the forms that actually occur. Three or four is normal. Twenty means the name
is wrong for the recogniser and you should pick another one.

## Failure two: it wakes on its own

This is the expensive one. A wake word that overlaps ordinary speech turns the
agent into a participant who interrupts constantly, and one such incident in a
meeting with a customer costs more than a week of correct answers earns.

A real example: a Portuguese-language deployment tried the name *Minino*. Every
recogniser returned it as *menino* — a common word meaning "boy". The trigger
fired on unrelated conversation, repeatedly. The name was changed to a word that
does not exist in the language, and the false positives stopped entirely.

`tacet check` refuses the most obvious collisions, but it only knows English
function words. It cannot know that your chosen name is a common noun in the
language your meetings are held in.

## What makes a good one

- **Two syllables or more.** Single syllables collide with everything.
- **Not a word in the language your meetings use.** Invented is fine. Borrowed
  from another language is fine.
- **Distinct consonants.** Names built from soft sounds arrive as mush.
- **Not a participant's name**, for obvious reasons.

Names that work well in practice look like product names: *Nova*, *Kestrel*,
*Vela*, *Orin*. Names that fail look like words: *Echo*, *Ok*, *Hey*, *Note*.

## Testing it before a real meeting

```bash
tacet check          # after `bun link`; otherwise `bun run src/cli.ts check`
```

Prints the compiled pattern and rejects the collisions it can detect. Read the
pattern: it is a regular expression with word boundaries, and if you see
something you did not expect, the aliases are wrong.
