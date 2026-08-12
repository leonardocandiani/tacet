// The live notebook: structured notes kept while the meeting is still running.
//
// Transcribing everything and summarising at the end is the easy shape, and it
// is what every notetaker does. It has two problems. The obvious one is that a
// crash loses the meeting. The subtler one is that nobody can ask "what have we
// decided so far?" halfway through, which is exactly when it matters.
//
// So the notebook is incremental. Every pass reads only what is new, and merges
// into a running set of decisions, action items and open questions. The end-of-
// meeting minutes are then a formatting job over a structure that already
// exists, not a single heroic call over an hour of text.

export interface Decision {
  id: string;
  what: string;
  /** Who stated it, when known. Never guessed. */
  by?: string;
  /** Seconds into the meeting, for citation back to the transcript. */
  at: number;
}

export interface ActionItem {
  id: string;
  what: string;
  /** Left undefined rather than guessed — an invented owner is worse than none. */
  owner?: string;
  due?: string;
  at: number;
}

export interface OpenQuestion {
  id: string;
  what: string;
  at: number;
  /** Set when a later passage answers it. */
  answered?: string;
}

export interface Notebook {
  decisions: Decision[];
  actions: ActionItem[];
  questions: OpenQuestion[];
  /** Transcript offset already folded in, so passes never re-read the same text. */
  consumedUntil: number;
}

export function newNotebook(): Notebook {
  return { decisions: [], actions: [], questions: [], consumedUntil: 0 };
}

export interface NotebookDelta {
  decisions?: Array<Omit<Decision, 'id'>>;
  actions?: Array<Omit<ActionItem, 'id'>>;
  questions?: Array<Omit<OpenQuestion, 'id'>>;
  /** Text of questions this passage answered, matched loosely against open ones. */
  answered?: Array<{ question: string; answer: string }>;
}

/** Cheap identity for a note: the first words, normalised. Enough to catch the
 *  same decision restated in the next pass, which is the common duplicate. */
function fingerprint(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .join(' ');
}

function has(items: Array<{ what: string }>, what: string): boolean {
  const fp = fingerprint(what);
  return items.some((i) => fingerprint(i.what) === fp);
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

function foldDecisions(into: Decision[], from: NotebookDelta['decisions']): void {
  for (const d of from || []) {
    if (!d.what?.trim() || has(into, d.what)) continue;
    into.push({ ...d, id: nextId('d') });
  }
}

/** A later pass often supplies the owner or deadline the first pass lacked, so
 *  a repeat enriches the existing item. Never the reverse: nothing must not
 *  overwrite something. */
function foldActions(into: ActionItem[], from: NotebookDelta['actions']): void {
  for (const a of from || []) {
    if (!a.what?.trim()) continue;
    const existing = into.find((x) => fingerprint(x.what) === fingerprint(a.what));
    if (!existing) {
      into.push({ ...a, id: nextId('a') });
      continue;
    }
    if (!existing.owner && a.owner) existing.owner = a.owner;
    if (!existing.due && a.due) existing.due = a.due;
  }
}

function foldQuestions(into: OpenQuestion[], delta: NotebookDelta): void {
  for (const q of delta.questions || []) {
    if (!q.what?.trim() || has(into, q.what)) continue;
    into.push({ ...q, id: nextId('q') });
  }
  for (const { question, answer } of delta.answered || []) {
    const target = into.find((q) => fingerprint(q.what) === fingerprint(question));
    if (target) target.answered = answer;
  }
}

/** Folds one extraction pass into the notebook. Pure: callers keep the result.
 *
 *  Deduplication happens here rather than in the prompt because a model asked to
 *  "avoid repeating" will still repeat, and because the notebook is the only
 *  place that knows what every earlier pass found. */
export function merge(book: Notebook, delta: NotebookDelta, consumedUntil: number): Notebook {
  const out: Notebook = {
    decisions: [...book.decisions],
    actions: [...book.actions],
    questions: [...book.questions],
    consumedUntil: Math.max(book.consumedUntil, consumedUntil),
  };

  foldDecisions(out.decisions, delta.decisions);
  foldActions(out.actions, delta.actions);
  foldQuestions(out.questions, delta);

  return out;
}

/** What is still open — the answer to "where are we?" mid-meeting. */
export function pending(book: Notebook): OpenQuestion[] {
  return book.questions.filter((q) => !q.answered);
}

export function isEmpty(book: Notebook): boolean {
  return !book.decisions.length && !book.actions.length && !book.questions.length;
}

/** A spoken-length status, for when someone asks the agent to catch them up.
 *  Deliberately terse: this becomes audio, and audio cannot be skimmed. */
export function speakableStatus(book: Notebook): string {
  if (isEmpty(book)) return 'Nothing settled yet.';

  const parts: string[] = [];
  if (book.decisions.length) {
    parts.push(`${book.decisions.length} decision${book.decisions.length > 1 ? 's' : ''} so far`);
  }
  if (book.actions.length) {
    const owned = book.actions.filter((a) => a.owner).length;
    parts.push(`${book.actions.length} action item${book.actions.length > 1 ? 's' : ''}${owned ? `, ${owned} with an owner` : ''}`);
  }
  const open = pending(book).length;
  if (open) parts.push(`${open} still open`);

  const last = book.decisions[book.decisions.length - 1];
  const tail = last ? ` The last one was: ${last.what}` : '';
  return `${parts.join(', ')}.${tail}`;
}
