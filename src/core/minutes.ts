// Turning a finished meeting into minutes someone will actually read.
//
// The notebook already holds decisions, actions and open questions, gathered
// while the meeting ran. So this pass has a narrow job: write a title and a
// summary, and tidy what the notebook collected. That is a much smaller ask than
// "read this hour of text and understand it", and it fails far less often.

import type { Brain, Minutes, Utterance } from '../adapters/contracts';
import { pending, type Notebook } from './notebook';

export interface MinutesOptions {
  /** Written into the prompt so the output matches the meeting's language. */
  language?: string;
  /** Extra house rules: terminology, tone, what to leave out. */
  guidance?: string;
  maxTokens?: number;
}

const SECTIONS = ['Summary', 'Decisions', 'Action items', 'Open questions'] as const;

/** Minutes missing a section are minutes that were cut off mid-generation, and
 *  truncated minutes mislead worse than absent ones: whoever reads the summary
 *  assumes that was the whole meeting. */
export function looksComplete(text: string): boolean {
  return Boolean(extractTitle(text).title) && SECTIONS.every((h) => new RegExp(`^#{1,3}\\s*${h}\\s*$`, 'mi').test(text));
}

const SECTION_WORDS = /^(summary|decisions?|action items?|open questions?|minutes)\b/i;

/** The model puts the title in the document's first heading, because that is
 *  what writing a document means. Asking for a "## Title" section with the name
 *  underneath got rejected output from two different models. */
export function extractTitle(text: string): { title: string; body: string } {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (!line) continue;
    const m = line.match(/^#{1,3}\s+(.+?)\s*$/);
    if (!m) break;
    const candidate = (m[1] ?? '').replace(/^[*_\s]+|[*_\s]+$/g, '').trim();
    if (SECTION_WORDS.test(candidate)) break;
    lines.splice(i, 1);
    return { title: candidate, body: lines.join('\n').trim() };
  }
  return { title: '', body: text.trim() };
}

function transcriptFor(utterances: Utterance[], limit: number): string {
  const text = utterances.map((u) => `${u.speaker || 'unknown'}: ${u.text}`).join('\n');
  if (text.length <= limit) return text;
  // Keep the end: meetings decide things late. Mark the cut so the model knows
  // it is looking at a tail rather than a whole.
  return `[earlier portion omitted]\n${text.slice(-limit)}`;
}

function notebookBriefing(book: Notebook): string {
  const bits: string[] = [];
  if (book.notes?.length) {
    bits.push(`Noted during the meeting:\n${book.notes.map((n) => `- ${n.what}`).join('\n')}`);
  }
  if (book.decisions.length) {
    bits.push(`Decisions noted during the meeting:\n${book.decisions.map((d) => `- ${d.what}`).join('\n')}`);
  }
  if (book.actions.length) {
    bits.push(
      `Action items noted during the meeting:\n${book.actions
        .map((a) => `- ${a.what}${a.owner ? ` (owner: ${a.owner})` : ''}${a.due ? ` (due: ${a.due})` : ''}`)
        .join('\n')}`,
    );
  }
  const open = pending(book);
  if (open.length) bits.push(`Questions still open:\n${open.map((q) => `- ${q.what}`).join('\n')}`);
  return bits.join('\n\n') || 'No structured notes were captured during the meeting.';
}

function instructions(opts: MinutesOptions): string {
  return [
    'You write the minutes of a meeting from its transcript and the notes taken during it.',
    '',
    'Structure, in this exact order and in Markdown:',
    '# <title> — the FIRST line is the title: three to seven words naming what the',
    'meeting was about, the way someone writes it in a calendar. Never the room code,',
    'never the bare word "meeting".',
    '## Summary — three to five sentences on what was covered.',
    '## Decisions — one line each. If nothing was settled, write "Nothing was settled."',
    '## Action items — action, owner and deadline when stated. One line each.',
    '## Open questions — what was left unanswered.',
    '',
    'Rules: invent nothing. If an owner was never named, write "no owner assigned"',
    'rather than guessing. The transcript is machine-generated and contains',
    'recognition errors: when context makes the intended word obvious (a product,',
    'a system, a person), write the correct one.',
    opts.language ? `Write in ${opts.language}.` : '',
    opts.guidance || '',
  ]
    .filter(Boolean)
    .join('\n');
}

export interface DraftedMinutes {
  title: string;
  markdown: string;
  minutes: Minutes;
}

/** Writes the minutes. Returns null when no provider produced a complete
 *  document — the caller keeps the transcript either way. */
export async function writeMinutes(
  brain: Brain,
  utterances: Utterance[],
  book: Notebook,
  opts: MinutesOptions = {},
): Promise<DraftedMinutes | null> {
  if (!utterances.length) return null;

  const raw = await brain
    .complete({
      system: instructions(opts),
      user: [
        'Notes taken during the meeting:',
        notebookBriefing(book),
        '',
        'Transcript:',
        transcriptFor(utterances, 60_000),
      ].join('\n'),
      maxTokens: opts.maxTokens ?? 2_000,
      temperature: 0.3,
    })
    .catch(() => '');

  if (!looksComplete(raw)) return null;

  const { title, body } = extractTitle(raw);
  return {
    title,
    markdown: body,
    minutes: {
      title,
      summary: sectionOf(body, 'Summary'),
      decisions: bulletsOf(body, 'Decisions'),
      actions: bulletsOf(body, 'Action items').map(parseAction),
      openQuestions: bulletsOf(body, 'Open questions'),
    },
  };
}

/** Reads one section's prose out of the rendered document.
 *
 *  Walks the lines rather than matching one regular expression across the whole
 *  document. The regex version worked for every section except the last, because
 *  it terminated on a lookahead for the next heading and JavaScript has no
 *  end-of-input escape — so the final section, which is where the open questions
 *  live, silently came back empty. */
export function sectionOf(markdown: string, heading: string): string {
  const wanted = heading.trim().toLowerCase();
  const out: string[] = [];
  let inside = false;

  for (const line of markdown.split('\n')) {
    const m = line.match(/^#{1,3}\s*(.*?)\s*$/);
    if (m) {
      const name = (m[1] ?? '').trim().toLowerCase();
      if (inside) break;
      inside = name === wanted;
      continue;
    }
    if (inside) out.push(line);
  }

  return out.join('\n').trim();
}

export function bulletsOf(markdown: string, heading: string): string[] {
  return sectionOf(markdown, heading)
    .split('\n')
    .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
    // Anchored: an item genuinely starting with "none" — "None of the vendors
    // replied, decide by Friday" — is content, not the model's way of saying the
    // section is empty, and dropping it lost a real open question.
    .filter((l) => l.length > 0 && !/^(none|nothing (was )?(settled|decided|recorded)?)[.!]?$/i.test(l));
}

/** Splits "Review the leads — Sam — Friday" into its parts. Em dash, hyphen and
 *  parenthesised owners all occur in practice. */
/** Up to three capitalised words, which is what a name looks like when a model
 *  writes one. "(blocked on legal review)" is not a person, and an action item
 *  attributed to a phrase nobody can chase is worse than one with no owner. */
const NAME_SHAPED = /^[A-Z][\p{L}.'-]*(?:\s+[A-Z][\p{L}.'-]*){0,2}$/u;

export function parseAction(line: string): { what: string; owner?: string; due?: string } {
  const paren = line.match(/^(.*?)\s*\((owner:\s*)?([^,)]+?)(?:,\s*(?:due:\s*)?([^)]+))?\)\s*$/i);
  if (paren) return fromParentheses(line, paren);

  const parts = line.split(/\s+[—–-]\s+/).map((p) => p.trim()).filter(Boolean);
  const [what = line.trim(), second, third] = parts;
  // "Send the quote — by Friday" has a deadline in the position an owner would
  // occupy. Attributing the task to "by Friday" is the same failure as the
  // parenthetical one: a name nobody can chase, printed as if it were a person.
  if (second && !third && !NAME_SHAPED.test(second)) {
    return { what, owner: undefined, due: named(second) };
  }
  return { what, owner: named(second), due: named(third) };
}

const UNKNOWN = /^(no owner assigned|unassigned|tbd|n\/a)$/i;

function named(value: string | undefined): string | undefined {
  return value && !UNKNOWN.test(value) ? value : undefined;
}

function fromParentheses(line: string, m: RegExpMatchArray): { what: string; owner?: string; due?: string } {
  const candidate = m[3]?.trim();
  const labelled = Boolean(m[2]);
  if (!candidate || (!labelled && !NAME_SHAPED.test(candidate))) {
    return { what: line.trim(), owner: undefined, due: undefined };
  }
  return { what: (m[1] ?? '').trim(), owner: named(candidate), due: named(m[4]?.trim()) };
}

