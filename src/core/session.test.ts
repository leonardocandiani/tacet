import { describe, expect, test } from 'bun:test';
import { DEFAULT_SESSION, NEEDS_DATA, NO_REPLY, Session, parseDelta, type SessionConfig } from './session';
import { DEFAULT_FLOOR } from './floor';
import type { Brain, MeetingHandle, MeetingRecord, Sink, SpokenAudio, Synthesizer, Transport, Utterance } from '../adapters/contracts';

const HANDLE: MeetingHandle = { id: 'm1', room: 'abc-defg-hij', platform: 'test' };

/** A transport driven entirely by the test: no network, no browser, no clock. */
class FakeTransport implements Transport {
  readonly name = 'fake';
  spoken: string[] = [];
  chat: string[] = [];
  stopped = 0;
  state: 'live' | 'ended' = 'live';
  private lines: Utterance[] = [];

  async join(): Promise<MeetingHandle> {
    return HANDLE;
  }
  async leave(): Promise<void> {
    this.state = 'ended';
  }
  async status() {
    return this.state;
  }
  async transcript(): Promise<Utterance[]> {
    return [...this.lines];
  }
  async speak(_h: MeetingHandle, audio: SpokenAudio): Promise<void> {
    this.spoken.push(new TextDecoder().decode(audio.pcm));
  }
  async stopSpeaking(): Promise<void> {
    this.stopped += 1;
  }
  async postToChat(_h: MeetingHandle, text: string): Promise<void> {
    this.chat.push(text);
  }

  say(offset: number, text: string, speaker = 'Alex'): void {
    const found = this.lines.find((l) => l.offset === offset);
    if (found) found.text = text;
    else this.lines.push({ offset, text, speaker });
  }
}

/** Echoes a scripted queue of answers, recording what it was asked. */
class ScriptedBrain implements Brain {
  readonly name = 'scripted';
  asked: string[] = [];
  constructor(private answers: string[]) {}
  async complete(req: { user: string }): Promise<string> {
    this.asked.push(req.user);
    return this.answers.shift() ?? NO_REPLY;
  }
}

class FakeVoice implements Synthesizer {
  readonly name = 'fake-voice';
  async synthesize(text: string): Promise<SpokenAudio> {
    return { pcm: new TextEncoder().encode(text).buffer as ArrayBuffer, sampleRate: 24_000 };
  }
}

class CollectingSink implements Sink {
  readonly name = 'collect';
  records: MeetingRecord[] = [];
  async deliver(r: MeetingRecord) {
    this.records.push(r);
    return { ok: true, location: 'memory' };
  }
}

function makeConfig(over: Partial<SessionConfig> = {}): SessionConfig {
  return {
    ...DEFAULT_SESSION,
    floor: { ...DEFAULT_FLOOR, wake: /\bnova\b/i },
    persona: 'You are a helpful meeting assistant named Nova.',
    ...over,
  };
}

/** A clock the test advances by hand, so settle windows are exact. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('session loop', () => {
  test('says nothing when nobody addressed it', async () => {
    const transport = new FakeTransport();
    const fast = new ScriptedBrain([]);
    const clock = fakeClock();
    const s = new Session(HANDLE, { transport, fast, sinks: [], clock: clock.now }, makeConfig());

    transport.say(1, 'so the deploy went out on friday');
    await s.tick();
    clock.advance(5_000);
    await s.tick();

    expect(transport.spoken).toHaveLength(0);
    expect(fast.asked).toHaveLength(0);
  });

  test('answers when addressed, once the sentence settles', async () => {
    const transport = new FakeTransport();
    const fast = new ScriptedBrain(['We agreed on the twentieth.']);
    const clock = fakeClock();
    const s = new Session(
      HANDLE,
      { transport, fast, voice: new FakeVoice(), sinks: [], clock: clock.now },
      makeConfig(),
    );

    transport.say(1, 'nova, when do we ship');
    await s.tick();
    expect(transport.spoken).toHaveLength(0); // still settling

    clock.advance(2_000);
    await s.tick();
    expect(transport.spoken).toEqual(['We agreed on the twentieth.']);
  });

  test('does not act on a sentence that is still growing', async () => {
    const transport = new FakeTransport();
    const fast = new ScriptedBrain(['answer']);
    const clock = fakeClock();
    const s = new Session(HANDLE, { transport, fast, voice: new FakeVoice(), sinks: [], clock: clock.now }, makeConfig());

    transport.say(1, 'nova, when');
    await s.tick();
    clock.advance(1_000);
    transport.say(1, 'nova, when do we ship the beta');
    await s.tick();
    clock.advance(1_000);

    await s.tick();
    expect(transport.spoken).toHaveLength(0);

    clock.advance(1_500);
    await s.tick();
    expect(fast.asked[0]).toContain('when do we ship the beta');
  });

  test('a baseline stops it replying to the backlog', async () => {
    const transport = new FakeTransport();
    const fast = new ScriptedBrain(['should never be said']);
    const clock = fakeClock();
    const s = new Session(HANDLE, { transport, fast, voice: new FakeVoice(), sinks: [], clock: clock.now }, makeConfig());

    transport.say(1, 'nova, are you there?');
    transport.say(2, 'nova, hello?');
    expect(await s.establishBaseline()).toBe(2);

    clock.advance(10_000);
    await s.tick();
    expect(transport.spoken).toHaveLength(0);
  });

  test('NO_REPLY keeps it quiet even with the floor granted', async () => {
    const transport = new FakeTransport();
    const fast = new ScriptedBrain([NO_REPLY]);
    const clock = fakeClock();
    const s = new Session(HANDLE, { transport, fast, voice: new FakeVoice(), sinks: [], clock: clock.now }, makeConfig());

    transport.say(1, 'nova is a nice name for a product');
    clock.advance(2_000);
    await s.tick();
    expect(transport.spoken).toHaveLength(0);
  });

  test('a data request acknowledges first, then answers from the deep brain', async () => {
    const transport = new FakeTransport();
    const fast = new ScriptedBrain([NEEDS_DATA]);
    const deep = new ScriptedBrain(['Fourteen leads closed today.']);
    const clock = fakeClock();
    const s = new Session(
      HANDLE,
      { transport, fast, deep, voice: new FakeVoice(), sinks: [], clock: clock.now },
      makeConfig(),
    );

    transport.say(1, 'nova, how many leads closed today');
    await s.tick();
    clock.advance(2_000);
    await s.tick();

    expect(transport.spoken).toHaveLength(2);
    expect(transport.spoken[1]).toBe('Fourteen leads closed today.');
  });

  test('without a deep brain it says so instead of inventing', async () => {
    const transport = new FakeTransport();
    const fast = new ScriptedBrain([NEEDS_DATA]);
    const clock = fakeClock();
    const s = new Session(HANDLE, { transport, fast, voice: new FakeVoice(), sinks: [], clock: clock.now }, makeConfig());

    transport.say(1, 'nova, how many leads closed today');
    await s.tick();
    clock.advance(2_000);
    await s.tick();

    expect(transport.spoken).toHaveLength(1);
    expect(transport.spoken[0]).toContain('not wired to any data');
  });

  test('falls back to the chat panel when it has no voice', async () => {
    const transport = new FakeTransport();
    const fast = new ScriptedBrain(['Written instead of spoken.']);
    const clock = fakeClock();
    const s = new Session(HANDLE, { transport, fast, sinks: [], clock: clock.now }, makeConfig());

    transport.say(1, 'nova, when does the trial end?');
    await s.tick();
    clock.advance(2_000);
    await s.tick();

    expect(transport.spoken).toHaveLength(0);
    expect(transport.chat).toEqual(['Written instead of spoken.']);
  });

  test('"nova, go to sleep" silences it for the rest of the meeting', async () => {
    const transport = new FakeTransport();
    const fast = new ScriptedBrain(['nope', 'nope']);
    const clock = fakeClock();
    const s = new Session(HANDLE, { transport, fast, voice: new FakeVoice(), sinks: [], clock: clock.now }, makeConfig());

    transport.say(1, 'nova, go to sleep');
    await s.tick();
    clock.advance(2_000);
    await s.tick();
    expect(transport.spoken).toHaveLength(0); // a command is obeyed, not answered

    // The wake phrase is the way back in, by design: otherwise a muted agent
    // can only be recovered by restarting it mid-meeting.
    transport.say(2, 'nova, what about the budget');
    await s.tick();
    clock.advance(20_000);
    await s.tick();

    expect(transport.spoken).toEqual(['nope']);
  });

  test('ends the loop when the meeting ends', async () => {
    const transport = new FakeTransport();
    const s = new Session(HANDLE, { transport, fast: new ScriptedBrain([]), sinks: [], clock: fakeClock().now }, makeConfig());
    expect(await s.tick()).toBe(true);
    transport.state = 'ended';
    expect(await s.tick()).toBe(false);
  });

  test('checkpoints the record to sinks while the meeting runs', async () => {
    const transport = new FakeTransport();
    const sink = new CollectingSink();
    const clock = fakeClock();
    const s = new Session(
      HANDLE,
      { transport, fast: new ScriptedBrain([]), sinks: [sink], clock: clock.now },
      makeConfig({ checkpointMs: 1_000 }),
    );

    transport.say(1, 'some meeting content here');
    clock.advance(5_000);
    await s.tick();

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0].partial).toBe(true);
    expect(sink.records[0].utterances).toHaveLength(1);
  });

  test('a failing sink does not break the loop', async () => {
    const transport = new FakeTransport();
    const broken: Sink = {
      name: 'broken',
      deliver: async () => {
        throw new Error('disk full');
      },
    };
    const clock = fakeClock();
    const s = new Session(
      HANDLE,
      { transport, fast: new ScriptedBrain([]), sinks: [broken], clock: clock.now },
      makeConfig({ checkpointMs: 1_000 }),
    );

    transport.say(1, 'content');
    clock.advance(5_000);
    expect(await s.tick()).toBe(true);
  });

  test('a failing fast brain leaves it silent rather than crashing', async () => {
    const transport = new FakeTransport();
    const angry: Brain = {
      name: 'angry',
      complete: async () => {
        throw new Error('429 rate limited');
      },
    };
    const clock = fakeClock();
    const s = new Session(HANDLE, { transport, fast: angry, voice: new FakeVoice(), sinks: [], clock: clock.now }, makeConfig());

    transport.say(1, 'nova, hello');
    clock.advance(2_000);
    expect(await s.tick()).toBe(true);
    expect(transport.spoken).toHaveLength(0);
  });
});

describe('commands, holding and privacy', () => {
  test('a question turned away by the cooldown is answered later, not lost', async () => {
    const transport = new FakeTransport();
    const fast = new ScriptedBrain(['first answer', 'second answer']);
    const clock = fakeClock();
    const s = new Session(HANDLE, { transport, fast, voice: new FakeVoice(), sinks: [], clock: clock.now }, makeConfig());

    transport.say(1, 'nova, first question');
    await s.tick();
    clock.advance(2_000);
    await s.tick();
    expect(transport.spoken).toEqual(['first answer']);

    // Straight away, well inside the cooldown.
    transport.say(2, 'nova, second question');
    await s.tick();
    clock.advance(2_000);
    await s.tick();
    expect(transport.spoken).toHaveLength(1); // held, not answered

    // Once the cooldown lifts, the held question is delivered.
    clock.advance(12_000);
    await s.tick();
    expect(transport.spoken).toEqual(['first answer', 'second answer']);
  });

  test('a dictated decision is captured verbatim, without asking a model', async () => {
    const transport = new FakeTransport();
    const fast = new ScriptedBrain([]);
    const clock = fakeClock();
    const s = new Session(HANDLE, { transport, fast, voice: new FakeVoice(), sinks: [], clock: clock.now }, makeConfig());

    transport.say(1, "nova, that's a decision: budget stays at fifteen thousand");
    await s.tick();
    clock.advance(2_000);
    await s.tick();

    const book = s.snapshot().notebook;
    expect(book.decisions).toHaveLength(1);
    expect(book.decisions[0]?.what).toBe('budget stays at fifteen thousand');
    expect(fast.asked).toHaveLength(0); // no model involved
    expect(transport.spoken).toEqual(['Noted.']);
  });

  test('"where are we" is answered from the notebook, not the transcript', async () => {
    const transport = new FakeTransport();
    const clock = fakeClock();
    const s = new Session(
      HANDLE,
      { transport, fast: new ScriptedBrain([]), voice: new FakeVoice(), sinks: [], clock: clock.now },
      makeConfig(),
    );

    transport.say(1, 'nova, action item: Sam reviews the leads');
    await s.tick();
    clock.advance(2_000);
    await s.tick();

    transport.say(2, 'nova, where are we?');
    await s.tick();
    clock.advance(20_000);
    await s.tick();

    expect(transport.spoken[1]).toContain('1 action item');
  });

  test('off the record stops anything being written down', async () => {
    const transport = new FakeTransport();
    const clock = fakeClock();
    const s = new Session(
      HANDLE,
      { transport, fast: new ScriptedBrain([]), voice: new FakeVoice(), sinks: [], clock: clock.now },
      makeConfig(),
    );

    transport.say(1, 'nova, off the record');
    await s.tick();
    clock.advance(2_000);
    await s.tick();
    expect(transport.spoken).toEqual(['Off the record.']);

    transport.say(2, 'the acquisition price is confidential');
    await s.tick();
    clock.advance(6_000);
    await s.tick();

    const texts = s.snapshot().utterances.map((u) => u.text);
    expect(texts.some((t) => t.includes('acquisition'))).toBe(false);
  });

  test('off the record refuses an explicit capture, rather than filing it quietly', async () => {
    const transport = new FakeTransport();
    const clock = fakeClock();
    const s = new Session(
      HANDLE,
      { transport, fast: new ScriptedBrain([]), voice: new FakeVoice(), sinks: [], clock: clock.now },
      makeConfig(),
    );

    transport.say(1, 'nova, off the record');
    await s.tick();
    clock.advance(2_000);
    await s.tick();

    transport.say(2, "nova, that's a decision: we settle for forty million");
    await s.tick();
    clock.advance(6_000);
    await s.tick();

    // Nothing captured, and the refusal is spoken so nobody assumes it landed.
    expect(s.snapshot().notebook.decisions).toHaveLength(0);
    expect(transport.spoken[1]).toContain('off the record');
  });

  test('and recording resumes on request', async () => {
    const transport = new FakeTransport();
    const clock = fakeClock();
    const s = new Session(
      HANDLE,
      { transport, fast: new ScriptedBrain([]), voice: new FakeVoice(), sinks: [], clock: clock.now },
      makeConfig(),
    );

    transport.say(1, 'nova, off the record');
    await s.tick();
    clock.advance(2_000);
    await s.tick();

    transport.say(2, 'nova, back on the record');
    await s.tick();
    clock.advance(2_000);
    await s.tick();

    transport.say(3, 'this part is minuted');
    await s.tick();
    clock.advance(6_000);
    await s.tick();

    expect(s.snapshot().utterances.some((u) => u.text.includes('minuted'))).toBe(true);
  });
});

describe('salvaging model JSON', () => {
  test('reads a plain object', () => {
    expect(parseDelta('{"decisions":[]}')).toEqual({ decisions: [] });
  });

  test('reads it out of a fenced block', () => {
    expect(parseDelta('Sure!\n```json\n{"decisions":[{"what":"ship","at":1}]}\n```')).toMatchObject({
      decisions: [{ what: 'ship', at: 1 }],
    });
  });

  test('reads it out of surrounding prose', () => {
    expect(parseDelta('Here are the notes: {"actions":[]} — hope that helps')).toEqual({ actions: [] });
  });

  test('gives up cleanly on garbage', () => {
    expect(parseDelta('no json here')).toBeNull();
    expect(parseDelta('')).toBeNull();
    expect(parseDelta('{ broken')).toBeNull();
  });
});
