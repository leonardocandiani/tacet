# Security

tacet sits in meetings, listens to everything, and can be wired to an agent that
holds your tools. That combination deserves a plain description of what it does
with what it hears, and of where the sharp edges are. None of what follows is a
disclaimer: it is the threat model, and most of it is under your control.

## Reporting something

Open a [private advisory](https://github.com/leonardocandiani/tacet/security/advisories/new)
rather than a public issue. There is no bounty and no SLA — this is one person's
project — but real reports get answered.

## Anyone in the meeting is an untrusted input

Whoever is in the room can say anything, including sentences shaped like
instructions. Two things follow.

**The floor is decided in code, not by a model.** `src/core/floor.ts` decides
whether the agent may speak, and no prompt can talk its way past it. That is the
whole reason the decision is not delegated to the model.

**Speech reaching a model is fenced and labelled as third-party.** The prompt in
`addressedPrompt` marks the transcript as quoted material and tells the model that
instructions inside it are part of the conversation being reported, never commands
to follow. This reduces the risk; it does not eliminate it. Treat prompt
injection as possible, not prevented.

That matters most for the `command` brain, which spawns an executable you chose:

```jsonc
"deep": [{ "use": "command", "argv": ["claude", "-p"] }]
```

A question asked in the meeting reaches that process. **Run it with the narrowest
permissions that still answer your questions** — for a coding agent, read-only
tools and a workspace that holds nothing you would not read aloud:

```jsonc
"deep": [{
  "use": "command",
  "argv": ["claude", "-p", "--allowedTools", "Read,Grep,Glob"],
  "cwd": "/srv/meeting-facts"
}]
```

Do not point it at a shell, a workspace with production credentials, or anything
that writes. The agent has no allowlist of who may ask: everyone admitted to the
meeting can, including guests from outside your company.

## A config file is executable

`command` brains and `command` sinks run programs. A tacet config is therefore as
powerful as a shell script, and reviewing one before running it is the same kind
of decision as reviewing a `Makefile` somebody sent you. The config itself holds
no secrets — every key is referenced by environment variable name — which is what
makes it safe to *read*, not what makes it safe to *run*.

Spawned processes inherit this process's environment, so every API key exported
for tacet is visible to them. Give them their own environment if that matters to
you.

## What leaves the machine

Everything depends on the providers you configure.

- **Hosted brains and voices** (OpenAI, Anthropic, Gemini, ElevenLabs) receive
  transcript excerpts. For the fast path that is the recent conversation; for the
  note pass it is the passage being read.
- **The transport** sees the entire meeting: it is the thing in the room. Vexa,
  self-hosted, keeps that on your infrastructure.
- **Nothing else phones home.** No telemetry, no analytics, no update check.

`examples/private.json` is the configuration where nothing leaves the building:
local models, local transport, no hosted voice.

## Off the record, precisely

"Off the record" stops tacet recording: the words are dropped from the transcript
it keeps, they never reach the notebook, the minutes or any sink, and speech that
landed while the command was still settling is dropped too.

**It does not stop the transport.** The browser in the room keeps listening and
your transcription service keeps its own copy — tacet has no authority to delete
anything there. It also lives only in this process: start a new session against
the same meeting and it will read the server's full transcript, pause included.

If a conversation genuinely cannot be recorded, remove the bot from the meeting.
That is the only version of the promise that a system can actually keep.

## Secrets in logs

The log is written for the operator and can carry provider errors, including the
stderr of processes you configured. Known credential shapes are masked on the way
out (`src/redact.ts`), which is a net rather than a guarantee. Treat the log as
sensitive.

## Meeting records on disk

`fileSink` writes the transcript, the minutes and a JSON record under the
directory you name, with default permissions. Directory names are reduced to a
single safe path segment, so neither a room code from the command line nor a
title from a model can write outside that directory. Everything inside it is
plain text of a private conversation: put it somewhere with permissions that
reflect that, and consider disk encryption.

## Consent

Every platform shows the bot in the participant list, and recording people who
have not been told is a legal problem in many places and a trust problem
everywhere. Say it out loud at the start of the meeting. tacet does not do this
for you, and it will not pretend to be a person.
