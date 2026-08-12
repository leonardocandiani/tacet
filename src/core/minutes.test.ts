import { describe, expect, test } from 'bun:test';
import { bulletsOf, extractTitle, looksComplete, parseAction, sectionOf, writeMinutes } from './minutes';
import { merge, newNotebook } from './notebook';
import type { Brain, Utterance } from '../adapters/contracts';

const COMPLETE = `# Q3 Rollout and Launch Date

## Summary

It went fine.

## Decisions

- Launch on the twentieth

## Action items

- Draft the release notes — Sam — Friday

## Open questions

- Who signs off on pricing?`;

const said = (offset: number, text: string, speaker = 'Alex'): Utterance => ({ offset, text, speaker });

function brainReturning(text: string): Brain {
  return { name: 'stub', complete: async () => text };
}

describe('completeness', () => {
  test('accepts a document with a title and all four sections', () => {
    expect(looksComplete(COMPLETE)).toBe(true);
  });

  test('rejects one cut off mid-generation', () => {
    const truncated = COMPLETE.split('## Action items')[0] ?? '';
    expect(looksComplete(truncated)).toBe(false);
  });

  test('rejects one with no title', () => {
    expect(looksComplete(COMPLETE.replace('# Q3 Rollout and Launch Date\n\n', ''))).toBe(false);
  });
});

describe('title extraction', () => {
  test('takes the first heading as the title and removes it from the body', () => {
    const { title, body } = extractTitle(COMPLETE);
    expect(title).toBe('Q3 Rollout and Launch Date');
    expect(body.startsWith('## Summary')).toBe(true);
  });

  test('a document that opens with a section has no title', () => {
    expect(extractTitle('## Summary\n\nthings').title).toBe('');
  });

  test('works when the model uses ## for the title', () => {
    expect(extractTitle('## Pricing Review\n## Summary\n\nx').title).toBe('Pricing Review');
  });

  test('strips stray emphasis around the title', () => {
    expect(extractTitle('# **Pricing Review**\n\n## Summary\n\nx').title).toBe('Pricing Review');
  });
});

describe('reading sections back', () => {
  test('pulls prose out of a section', () => {
    expect(sectionOf(COMPLETE, 'Summary')).toBe('It went fine.');
  });

  test('pulls bullets out of a section', () => {
    expect(bulletsOf(COMPLETE, 'Decisions')).toEqual(['Launch on the twentieth']);
  });

  test('treats "nothing was settled" as empty rather than as an item', () => {
    const doc = '## Decisions\n\nNothing was settled.\n\n## Summary\n\nx';
    expect(bulletsOf(doc, 'Decisions')).toEqual([]);
  });
});

describe('action lines', () => {
  test('splits action, owner and deadline on dashes', () => {
    expect(parseAction('Draft the release notes — Sam — Friday')).toEqual({
      what: 'Draft the release notes',
      owner: 'Sam',
      due: 'Friday',
    });
  });

  test('reads the parenthesised form too', () => {
    expect(parseAction('Draft the notes (owner: Sam, due: Friday)')).toEqual({
      what: 'Draft the notes',
      owner: 'Sam',
      due: 'Friday',
    });
  });

  test('leaves an unassigned owner undefined rather than inventing one', () => {
    expect(parseAction('Confirm the window — no owner assigned')).toMatchObject({
      what: 'Confirm the window',
      owner: undefined,
    });
  });

  test('an action with no owner at all still parses', () => {
    expect(parseAction('Ship the thing')).toEqual({ what: 'Ship the thing', owner: undefined, due: undefined });
  });
});

describe('writing minutes', () => {
  const utterances = [said(1, 'lets settle the launch date'), said(12, 'the twentieth then')];

  test('returns the parsed structure when the model produces a full document', async () => {
    const out = await writeMinutes(brainReturning(COMPLETE), utterances, newNotebook());
    expect(out?.title).toBe('Q3 Rollout and Launch Date');
    expect(out?.minutes.decisions).toEqual(['Launch on the twentieth']);
    expect(out?.minutes.actions[0]).toMatchObject({ what: 'Draft the release notes', owner: 'Sam' });
    expect(out?.minutes.openQuestions).toHaveLength(1);
  });

  test('refuses a truncated document instead of delivering half a record', async () => {
    const half = '# Title\n\n## Summary\n\nIt was going well when the tokens ran';
    expect(await writeMinutes(brainReturning(half), utterances, newNotebook())).toBeNull();
  });

  test('returns null rather than throwing when the model fails', async () => {
    const angry: Brain = {
      name: 'angry',
      complete: async () => {
        throw new Error('rate limited');
      },
    };
    expect(await writeMinutes(angry, utterances, newNotebook())).toBeNull();
  });

  test('a meeting where nobody spoke has no minutes', async () => {
    expect(await writeMinutes(brainReturning(COMPLETE), [], newNotebook())).toBeNull();
  });

  test('the notes gathered during the meeting reach the prompt', async () => {
    const asked: string[] = [];
    const spy: Brain = {
      name: 'spy',
      complete: async (req) => {
        asked.push(req.user);
        return COMPLETE;
      },
    };
    const book = merge(newNotebook(), { decisions: [{ what: 'Migration runs on a Saturday', at: 30 }] }, 40);

    await writeMinutes(spy, utterances, book);
    expect(asked[0]).toContain('Migration runs on a Saturday');
  });
});
