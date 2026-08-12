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

/** Something worth writing down that is not a decision, a task or a question:
 *  a number, a name, a constraint. Dictated notes used to be filed as open
 *  questions, which put "the vendor charges per seat" under a heading promising
 *  it was unresolved. */
export interface Note {
  id: string;
  what: string;
  by?: string;
  at: number;
}

export interface Notebook {
  decisions: Decision[];
  actions: ActionItem[];
  questions: OpenQuestion[];
  notes: Note[];
  /** Transcript offset already folded in, so passes never re-read the same text. */
  consumedUntil: number;
}

export function newNotebook(): Notebook {
  return { decisions: [], actions: [], questions: [], notes: [], consumedUntil: 0 };
}

export interface NotebookDelta {
  notes?: Array<Omit<Note, 'id'>>;
  decisions?: Array<Omit<Decision, 'id'>>;
  actions?: Array<Omit<ActionItem, 'id'>>;
  questions?: Array<Omit<OpenQuestion, 'id'>>;
  /** Text of questions this passage answered, matched loosely against open ones. */
  answered?: Array<{ question: string; answer: string }>;
}

/** Cheap identity for a note: the first words, normalised. Enough to catch the
 *  same decision restated in the next pass, which is the common duplicate. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function fingerprint(text: string): string {
  return normalize(text).split(' ').slice(0, 8).join(' ');
}

/** Two notes are the same note when the text matches, or when one is the other
 *  still being transcribed — recognisers restate a sentence prefix-first, which
 *  is the duplicate worth collapsing.
 *
 *  Anything else is kept, even when the opening words coincide. Deciding that
 *  "hire two engineers for the platform team" supersedes "...for the data team"
 *  would drop a real decision on a guess, and a note nobody can find is worse
 *  than a note stated twice. */
function sameNote(a: string, b: string): boolean {
  const x = normalize(a);
  const y = normalize(b);
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return Boolean(short) && long.startsWith(`${short} `);
}

function find<T extends { what: string }>(items: T[], what: string): T | undefined {
  return items.find((i) => sameNote(i.what, what));
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

function foldNotes(into: Note[], from: NotebookDelta['notes']): void {
  for (const n of from || []) {
    if (!n.what?.trim() || find(into, n.what)) continue;
    into.push({ ...n, id: nextId('n') });
  }
}

/** A later pass usually restates a decision more completely than the first one
 *  caught it. The fuller sentence wins; nothing is dropped. */
function foldDecisions(into: Decision[], from: NotebookDelta['decisions']): void {
  for (const d of from || []) {
    if (!d.what?.trim()) continue;
    const at = into.findIndex((x) => sameNote(x.what, d.what));
    if (at < 0) {
      into.push({ ...d, id: nextId('d') });
      continue;
    }
    const existing = into[at] as Decision;
    if (d.what.length > existing.what.length) {
      into[at] = { ...existing, what: d.what, by: existing.by ?? d.by };
    }
  }
}

/** A later pass often supplies the owner or deadline the first pass lacked, so
 *  a repeat enriches the existing item. Never the reverse: nothing must not
 *  overwrite something. */
function foldActions(into: ActionItem[], from: NotebookDelta['actions']): void {
  for (const a of from || []) {
    if (!a.what?.trim()) continue;
    const at = into.findIndex((x) => sameNote(x.what, a.what));
    if (at < 0) {
      into.push({ ...a, id: nextId('a') });
      continue;
    }
    // Replaced rather than mutated in place: the notebook this one grew from is
    // still held elsewhere as a snapshot, and enriching it retroactively would
    // rewrite a record someone already read.
    const existing = into[at] as ActionItem;
    into[at] = {
      ...existing,
      what: a.what.length > existing.what.length ? a.what : existing.what,
      owner: existing.owner ?? a.owner,
      due: existing.due ?? a.due,
    };
  }
}

function foldQuestions(into: OpenQuestion[], delta: NotebookDelta): void {
  for (const q of delta.questions || []) {
    if (!q.what?.trim() || find(into, q.what)) continue;
    into.push({ ...q, id: nextId('q') });
  }
  for (const { question, answer } of delta.answered || []) {
    // Matching an answer back to its question is the one place a loose match is
    // right: nobody repeats a question word for word before answering it.
    const at = into.findIndex((q) => fingerprint(q.what) === fingerprint(question));
    const target = into[at];
    if (target) into[at] = { ...target, answered: answer };
  }
}

/** Folds one extraction pass into the notebook. Pure: callers keep the result.
 *
 *  Deduplication happens here rather than in the prompt because a model asked to
 *  "avoid repeating" will still repeat, and because the notebook is the only
 *  place that knows what every earlier pass found. */
function list<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value.filter((v) => v && typeof v === 'object') : [];
}

export function merge(book: Notebook, delta: NotebookDelta, consumedUntil: number): Notebook {
  const out: Notebook = {
    decisions: [...book.decisions],
    actions: [...book.actions],
    questions: [...book.questions],
    notes: [...(book.notes ?? [])],
    consumedUntil: Math.max(book.consumedUntil, consumedUntil),
  };

  // Every list here arrives from a language model. Asking for an array and being
  // handed an object is routine, and a `for...of` over it throws from inside the
  // meeting loop — which used to end the meeting and lose the transcript with it.
  foldNotes(out.notes, list(delta.notes));
  foldDecisions(out.decisions, list(delta.decisions));
  foldActions(out.actions, list(delta.actions));
  foldQuestions(out.questions, { questions: list(delta.questions), answered: list(delta.answered) });

  return out;
}

/** What is still open — the answer to "where are we?" mid-meeting. */
export function pending(book: Notebook): OpenQuestion[] {
  return book.questions.filter((q) => !q.answered);
}

export function isEmpty(book: Notebook): boolean {
  return !book.decisions.length && !book.actions.length && !book.questions.length && !book.notes?.length;
}

/** A spoken-length status, for when someone asks the agent to catch them up.
 *  Deliberately terse: this becomes audio, and audio cannot be skimmed. */
function allAnswered(book: Notebook): string {
  const answered = book.questions.filter((q) => q.answered).length;
  if (!answered) return 'Nothing settled yet.';
  return `Nothing open. ${answered} question${answered > 1 ? 's' : ''} answered so far.`;
}

function countOf(label: string, n: number, extra = ''): string[] {
  return n ? [`${n} ${label}${n > 1 ? 's' : ''}${extra}`] : [];
}

export function speakableStatus(book: Notebook): string {
  if (isEmpty(book)) return 'Nothing settled yet.';

  const owned = book.actions.filter((a) => a.owner).length;
  const parts = [
    ...countOf('decision', book.decisions.length),
    ...countOf('action item', book.actions.length, owned ? `, ${owned} with an owner` : ''),
    ...countOf('note', book.notes?.length ?? 0),
    ...(pending(book).length ? [`${pending(book).length} still open`] : []),
  ];

  // Everything logged has since been answered: with no counts to report this
  // used to come out as a spoken full stop, which sounds like a malfunction.
  if (!parts.length) return allAnswered(book);

  const last = book.decisions[book.decisions.length - 1];
  return `${parts.join(', ')}.${last ? ` The last one was: ${last.what}` : ''}`;
}

