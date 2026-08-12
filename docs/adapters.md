# Writing an adapter

Every external dependency enters through one interface in
[`src/adapters/contracts.ts`](../src/adapters/contracts.ts). Nothing in `src/core`
knows which implementation is in play, which is why the decision logic can be
tested without a network.

Adding one is a function and a `case`. There is no plugin loader, no registry, no
lifecycle. If you want a provider that is not here, this is the whole job.

## A brain

```ts
import type { Brain, CompletionRequest } from '../adapters/contracts';

export function myBrain(opts: { apiKey: string }): Brain {
  return {
    name: 'mine',
    async complete(req: CompletionRequest): Promise<string> {
      const r = await fetch('https://example.com/v1/complete', {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({ system: req.system, prompt: req.user }),
        signal: req.signal ?? AbortSignal.timeout(20_000),
      });
      if (!r.ok) throw new Error(`http ${r.status}`);   // throwing moves the chain on
      return (await r.json()).text;
    },
  };
}
```

Two rules carry most of the weight:

**Throw on failure.** The fallback chain works by catching. A provider that
returns an empty string on error looks successful and stops the chain, and the
agent goes quiet for the rest of the meeting.

**Honour the signal.** A hanging provider is the common failure, not an erroring
one. Without a deadline the chain never reaches its fallback.

Register it in [`src/wire.ts`](../src/wire.ts):

```ts
case 'mine':
  return myBrain({ apiKey: readKey(ref) });
```

…and add the name to the `BRAINS` list, so an unknown value fails with a useful
message instead of a stack trace.

## A sink

Sinks receive the record and never throw into the meeting loop — a failed
delivery must not cost the transcript.

```ts
export function ticketSink(opts: { url: string }): Sink {
  return {
    name: 'tickets',
    async deliver(record) {
      if (record.partial) return { ok: true, location: 'skipped (partial)' };
      for (const action of record.minutes?.actions ?? []) {
        await fetch(opts.url, { method: 'POST', body: JSON.stringify(action) });
      }
      return { ok: true, location: opts.url };
    },
  };
}
```

Note `record.partial`. The record is delivered periodically while the meeting
runs — that is what makes a crash survivable. Most integrations only want the
finished thing; the `files` sink wants both.

If you would rather not write TypeScript at all, the `command` sink pipes the
record as JSON into any executable:

```jsonc
{ "use": "command", "argv": ["./scripts/file-tickets.sh"] }
```

## A transport

The largest interface, and the one worth reading before implementing: it has to
join, report status, produce utterances, and optionally speak.

Three things a transport must get right:

**Stable offsets.** `offset` is the identity of an utterance. Transports re-emit
the same offset with improved text as recognition settles, and the session dedupes
on it. An offset that changes between polls produces duplicated speech.

**No lying about the end.** Return `live` when you cannot tell. Reporting `ended`
by mistake abandons a running meeting; reporting `live` by mistake costs one extra
poll.

**Raw PCM for speech.** `SpokenAudio` carries signed 16-bit little-endian mono
with no container. A WAV header arriving at a virtual microphone is audible in the
room as a click before every sentence.

## Testing without a network

The fakes in [`src/core/session.test.ts`](../src/core/session.test.ts) are a
working reference: a transport driven by the test, a brain that returns scripted
answers, and a hand-advanced clock. Copy them. The entire decision loop is tested
this way, and it runs in milliseconds.
