# Getting a bot into the room

tacet does not join meetings by itself. Something has to open a browser, sit in
the call and hand over audio. That something is the transport, and it is the only
part of this system that has to fight with a meeting platform.

## Vexa (shipped)

[Vexa](https://github.com/Vexa-ai/vexa) is Apache-2.0 and self-hosted. It runs a
container with a real browser that joins as a participant, captures audio and
attributes speech to the participant the platform shows as active. It supports
Google Meet, Teams, Zoom and Jitsi; the adapter here targets Meet.

```jsonc
{
  "transport": {
    "use": "vexa",
    "baseUrl": "http://localhost:18056",
    "keyEnv": "VEXA_API_KEY"
  }
}
```

### Two things worth knowing before you deploy it

**Fetch transcripts by meeting id, never by room code.** The route keyed on room
code returns the *most recent* session for that code, and a bot joins the same
room repeatedly over a day. A meeting once closed with an empty record because the
newest session for that code had died in the waiting room, while the real one —
with the entire conversation in it — was the session before. The adapter here uses
`/transcripts/by-id/{id}` for exactly this reason.

**Raise `max_time_left_alone`.** The default is around ten minutes. Participants
who mute themselves stop registering in the platform's own "is anyone here"
signal, so a quiet room reads as an empty one and the bot leaves a meeting that is
still going. The adapter defaults to an hour.

### Speaking

Two channels, chosen by config. Newer deployments expose an API route:

```jsonc
"speech": { "via": "api" }
```

Older ones only listen on a Redis channel inside the container:

```jsonc
"speech": { "via": "redis", "container": "vexa-redis-1", "cli": "valkey-cli" }
```

The Redis path passes the payload on **stdin**, not as a command argument. This is
not fussiness: an argument goes through the shell's encoding, and accented text
arrives mangled — in practice the agent speaks a sentence with the accents
stripped, which is audible and wrong in every language that has them.

## Writing another one

The interface is in [`contracts.ts`](../src/adapters/contracts.ts) and the
requirements are in [adapters.md](adapters.md). Candidates worth building:

- **[Recall.ai](https://recall.ai)** — commercial, hosted, no infrastructure. The
  fastest path to a working demo, and the one that takes your audio off-premises.
- **[Attendee](https://github.com/attendee-labs/attendee)** — open source, similar
  shape to Vexa.
- **A file transport** — read a recording and replay it through the same loop.
  This is the cheapest way to test decision logic against a real meeting, and it
  needs no meeting platform at all.

## The one thing no transport can fix

Nobody joins a meeting invisibly, and nobody should. Every platform shows the bot
in the participant list, and recording people who have not been told is a legal
problem in many jurisdictions and a trust problem in all of them.

Configure a spoken notice on join, and leave it on.
