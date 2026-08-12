import { describe, expect, test } from 'bun:test';
import { commandSink, fileSink, memorySink, renderMarkdown, slug, webhookSink } from './sinks';
import type { MeetingRecord } from './contracts';

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function recordWith(over: { title: string; room?: string }): MeetingRecord {
  return {
    handle: { id: 'm1', room: over.room ?? 'abc-defg-hij', platform: 'test' },
    title: over.title,
    startedAt: '2026-08-12T10:00:00.000Z',
    endedAt: '2026-08-12T11:00:00.000Z',
    participants: ['Ana'],
    utterances: [{ offset: 1, text: 'hello', speaker: 'Ana' }],
    partial: false,
  };
}


const RECORD: MeetingRecord = {
  handle: { id: '7', room: 'abc-defg-hij', platform: 'google_meet' },
  title: 'Q3 Rollout and Launch Date',
  startedAt: '2026-08-12T14:00:00.000Z',
  participants: ['Alex', 'Sam'],
  utterances: [
    { offset: 1, text: 'Where did we land on the date?', speaker: 'Alex' },
    { offset: 8, text: 'The twentieth.', speaker: 'Sam' },
    { offset: 12, text: 'For the beta cohort only.', speaker: 'Sam' },
  ],
  partial: false,
};

describe('slugs', () => {
  test('makes a filesystem-safe name', () => {
    expect(slug('Q3 Rollout and Launch Date')).toBe('q3-rollout-and-launch-date');
  });

  test('strips accents rather than encoding them', () => {
    expect(slug('Reunião de Preços')).toBe('reuniao-de-precos');
  });

  test('never produces leading, trailing or doubled separators', () => {
    expect(slug('  --- hello --- world ---  ')).toBe('hello-world');
  });

  test('is bounded, so a rambling title cannot break a path', () => {
    expect(slug('word '.repeat(60)).length).toBeLessThanOrEqual(60);
  });

  test('a title with nothing usable comes back empty, for the caller to handle', () => {
    expect(slug('!!! ??? ---')).toBe('');
  });
});

describe('markdown record', () => {
  test('groups consecutive turns by the same speaker', () => {
    const md = renderMarkdown(RECORD);
    expect(md).toContain('**Sam:** The twentieth. For the beta cohort only.');
  });

  test('carries the header facts', () => {
    const md = renderMarkdown(RECORD);
    expect(md).toContain('# Q3 Rollout and Launch Date');
    expect(md).toContain('Alex, Sam');
    expect(md).toContain('- State: ended');
  });

  test('says plainly when the record is still partial', () => {
    expect(renderMarkdown({ ...RECORD, partial: true })).toContain('in progress (partial record)');
  });

  test('renders minutes above the transcript when there are any', () => {
    const md = renderMarkdown({
      ...RECORD,
      minutes: {
        title: 'Q3',
        summary: 'It went fine.',
        decisions: ['Launch on the twentieth'],
        actions: [{ what: 'Draft notes', owner: 'Sam', due: 'Friday' }],
        openQuestions: [],
      },
    });
    expect(md.indexOf('## Summary')).toBeLessThan(md.indexOf('## Transcript'));
    expect(md).toContain('- Draft notes — Sam — Friday');
    expect(md).toContain('None left open.');
  });
});

describe('sinks', () => {
  test('the memory sink keeps what it is handed', async () => {
    const sink = memorySink();
    await sink.deliver(RECORD);
    expect(sink.records).toHaveLength(1);
  });

  test('a webhook skips partial records by default', async () => {
    const sink = webhookSink({ url: 'http://localhost:9/never' });
    const r = await sink.deliver({ ...RECORD, partial: true });
    expect(r).toMatchObject({ ok: true, location: 'skipped (partial)' });
  });

  test('a webhook reports failure instead of throwing into the meeting loop', async () => {
    // Port 9 is the discard port: the connection fails fast and locally.
    const sink = webhookSink({ url: 'http://127.0.0.1:9/dead', timeoutMs: 1_000 });
    const r = await sink.deliver(RECORD);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe('fileSink', () => {
  test('writes the transcript where it says it did, and nowhere else', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tacet-sink-'));
    const sink = fileSink({ dir });
    const result = await sink.deliver(recordWith({ title: 'Q3 rollout' }));

    expect(result.ok).toBe(true);
    const written = await readdir(result.location as string);
    expect(written).toContain('transcript.md');
    expect(written).toContain('meeting.json');
    expect(result.location as string).toContain('q3-rollout');
    await rm(dir, { recursive: true, force: true });
  });

  test('a title made only of punctuation cannot climb out of the meetings folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tacet-sink-'));
    const sink = fileSink({ dir });
    const result = await sink.deliver(recordWith({ title: '../../etc', room: '../../../tmp' }));

    expect(result.ok).toBe(true);
    expect((result.location as string).startsWith(dir)).toBe(true);
    expect(result.location as string).not.toContain('..');
    await rm(dir, { recursive: true, force: true });
  });

  test('an artifact key that is not a plain extension is skipped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tacet-sink-'));
    const sink = fileSink({ dir });
    const record = recordWith({ title: 'Weekly' });
    const result = await sink.deliver({ ...record, artifacts: { '../escaped': 'nope', txt: 'fine' } });

    const written = await readdir(result.location as string);
    expect(written).toContain('minutes.txt');
    expect(await readdir(dir)).toHaveLength(1);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('commandSink', () => {
  test('hands the record to the process on stdin', async () => {
    const out = join(await mkdtemp(join(tmpdir(), 'tacet-cmd-')), 'seen.json');
    const sink = commandSink({ argv: ['sh', '-c', `cat > ${out}`] });

    const result = await sink.deliver(recordWith({ title: 'Handover' }));
    expect(result.ok).toBe(true);
    expect(JSON.parse(await Bun.file(out).text()).title).toBe('Handover');
  });

  test('a failing command is reported, not thrown, and its output is scrubbed', async () => {
    const sink = commandSink({ argv: ['sh', '-c', 'echo "using sk-live-abcdefghijklmnop" >&2; exit 3'] });
    const result = await sink.deliver(recordWith({ title: 'Handover' }));

    expect(result.ok).toBe(false);
    expect(result.error).toContain('exited 3');
    expect(result.error).not.toContain('sk-live-abcdefghijklmnop');
  });
});
