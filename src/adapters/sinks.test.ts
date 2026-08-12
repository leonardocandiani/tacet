import { describe, expect, test } from 'bun:test';
import { memorySink, renderMarkdown, slug, webhookSink } from './sinks';
import type { MeetingRecord } from './contracts';

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
