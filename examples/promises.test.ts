import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { parseConfig, toSessionConfig } from '../src/config';
import { Session } from '../src/core/session';
import type { MeetingHandle, SpokenAudio, Transport, Utterance } from '../src/adapters/contracts';

// The documentation makes promises that are cheap to break by accident: a config
// block that stops parsing, an example that starts talking. These load the real
// files and check the real behaviour, so the promise fails in CI rather than in
// somebody's meeting.

const ROOT = join(new URL('.', import.meta.url).pathname, '..');
const HANDLE: MeetingHandle = { id: 'm1', room: 'abc-defg-hij', platform: 'test' };

class WatchfulTransport implements Transport {
  readonly name = 'watchful';
  spoken: string[] = [];
  chat: string[] = [];
  private lines: Utterance[] = [];

  async join(): Promise<MeetingHandle> {
    return HANDLE;
  }
  async leave(): Promise<void> {}
  async status() {
    return 'live' as const;
  }
  async transcript(): Promise<Utterance[]> {
    return this.lines.map((l) => ({ ...l }));
  }
  async speak(_h: MeetingHandle, audio: SpokenAudio): Promise<void> {
    this.spoken.push(new TextDecoder().decode(audio.pcm));
  }
  async stopSpeaking(): Promise<void> {}
  async postToChat(_h: MeetingHandle, text: string): Promise<void> {
    this.chat.push(text);
  }
  say(offset: number, text: string): void {
    this.lines.push({ offset, text, speaker: 'Alex' });
  }
}

describe('the config block in the README', () => {
  test('parses, exactly as somebody would paste it', async () => {
    const readme = await Bun.file(join(ROOT, 'README.md')).text();
    const block = readme.split('```jsonc')[1]?.split('```')[0];

    expect(block, 'the README should still contain a jsonc config block').toBeTruthy();
    const file = parseConfig(block as string);
    expect(file.name).toBeTruthy();
    expect(toSessionConfig(file).floor.wake.test(file.name)).toBe(true);
  });
});

describe('the listen-only example', () => {
  test('says nothing in any channel, not even to confirm', async () => {
    const file = parseConfig(await Bun.file(join(ROOT, 'examples/listen-only.json')).text());
    const config = toSessionConfig(file);
    const transport = new WatchfulTransport();

    let now = 1_000_000;
    const session = new Session(
      HANDLE,
      {
        transport,
        fast: { name: 'never', complete: async () => 'this should never be spoken' },
        sinks: [],
        clock: () => now,
      },
      config,
    );

    const lines = [
      `${file.name}, where are we?`,
      `${file.name}, that's a decision: we ship on the twentieth`,
      `${file.name}, action item: Sam reviews the leads`,
      `${file.name}, off the record`,
      `${file.name}, back on the record`,
      `${file.name}, what did we decide about pricing?`,
    ];

    for (const [i, line] of lines.entries()) {
      transport.say(i + 1, line);
      await session.tick();
      now += 2_000;
      await session.tick();
      now += 20_000;
    }

    expect(transport.spoken).toHaveLength(0);
    expect(transport.chat).toHaveLength(0);
  });

  test('still writes everything down', async () => {
    const file = parseConfig(await Bun.file(join(ROOT, 'examples/listen-only.json')).text());
    const transport = new WatchfulTransport();

    let now = 1_000_000;
    const session = new Session(
      HANDLE,
      { transport, fast: { name: 'never', complete: async () => 'NO_REPLY' }, sinks: [], clock: () => now },
      toSessionConfig(file),
    );

    transport.say(1, 'the vendor wants another two weeks');
    transport.say(2, `${file.name}, that's a decision: we ship on the twentieth`);
    await session.tick();
    now += 2_000;
    await session.tick();

    const snap = session.snapshot();
    expect(snap.utterances).toHaveLength(2);
    expect(snap.notebook.decisions[0]?.what).toContain('twentieth');
  });
});
