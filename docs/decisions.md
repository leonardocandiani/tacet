# What was rejected, and why

Most of these are the most-requested features in this category. They are absent on
purpose. If you disagree with one, the reasoning is here to argue with — and every
one of them is buildable as an adapter without forking anything.

## Always-on, no wake word

The most common request, usually phrased as wanting the interaction to feel
natural. It is also the fastest way to kill the product.

The arithmetic is one-sided. A wake word costs a fraction of a second per
question. A false positive costs an interruption in front of a customer, and one
of those ends the trial. The failure modes are not symmetrical, so the default
cannot be symmetrical either.

What people actually want from "natural" is not having to say the name every
sentence — and that exists: after the agent speaks, a window stays open, and a
reply inside it needs no name. See `followUpMs`.

## Proactive corrections

"Someone says a number that contradicts the database, so the agent corrects them."

It demonstrates the whole value proposition and it is unusable. Being publicly
corrected by software in front of your colleagues is humiliating, the agent will
sometimes be the one that is wrong, and the person now has to argue with a
machine in a meeting. If it has a correction, it can offer it when asked.

## Sentiment, engagement, or a talk-time leaderboard

Fragile measurement, presented with the authority of data, about people, in a
document that outlives the meeting and that they did not consent to being scored
in. Talk-time has a legitimate use in sales coaching, which is why it can be
built — but not by default, and not in the minutes everyone receives.

## Voice cloning

Not of participants, not of anyone. A recording that sounds like a colleague
saying something they did not say is a fraud primitive, and putting one inside an
artefact that also serves as the official record of a meeting is worse.

## Live translation

An excellent demo and a poor product: it consumes the entire latency budget that
the conversational path depends on, and it multiplies the surface where a
mistranslation becomes a minuted decision. Translate the finished minutes instead,
where a human can check them.

## OCR of the shared screen

Doubles the scope, ties the project to the bot's browser, and breaks whenever the
platform changes its layout. The transcript is what the meeting *said*; a slide is
what it *showed*, and those are different products.

## Auto-joining everything on the calendar

Turns installation into an OAuth flow, which is where most people stop. Worse, it
makes the agent's presence a default rather than a decision, which is precisely
backwards for something that records people. Join by link, deliberately.

## Speaker identification by voiceprint

Improves little over the display name the platform already reports, and creates a
biometric database as a side effect. Not worth it.

## A live web dashboard

Duplicates the interface surface while the text sink already carries state, notes
and commands. Worth revisiting once the shape of the product settles; not in a
first version.

---

## Rejected in the other direction

Two things that look like scope creep and are not, because they were built:

**Structured notes during the meeting, not after.** Summarising an hour of text in
one call is the easy shape and it fails in the two ways that matter: a crash loses
everything, and nobody can ask "where are we?" halfway through — which is exactly
when it is worth asking.

**Explicit capture by voice.** "That's a decision: …" bypasses the model entirely
and records verbatim. It is the difference between a record the team trusts and a
summary they re-check.

**A turn budget that also covers "Noted."** A confirmation is speech. Exempting it
was tempting — it is short, it is helpful, it is not really a *turn* — and it
meant that the listen-only configuration, the one the documentation tells you to
run in your first real meeting, posted into the customer's meeting chat. There is
now one path to speech and it is governed in one place.

---

## Decided against, after being built

**Merging a decision into the one it seems to correct.** The notebook used to
treat two decisions sharing their opening words as the same note, so "we ship on
Monday" followed by "we ship on Friday" kept only one. That is right roughly half
the time. The other half it silently deletes a real decision — "hire two engineers
for the platform team" and "…for the data team" are also eight identical opening
words. Nothing in the text distinguishes a correction from a second decision, so
the notebook stopped guessing: a restatement that merely extends what was already
captured collapses, anything else is kept, in the order it was said. A reader can
resolve a contradiction they can see. Nobody can resolve one they were never
shown.

**Making "off the record" durable across a restart.** It was tempting to persist
the paused ranges and re-apply them when a new session reads the same meeting. It
would also be a lie: the transport is still in the room, and its transcript — on
the server, outside this program's authority — holds the words either way. A
privacy control that covers only the copy nobody was worried about is worse than
one with a documented edge, because people trust it further than it goes. So the
scope is stated plainly in SECURITY.md instead: if it truly cannot be recorded,
remove the bot from the meeting.
