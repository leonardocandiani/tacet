// Spoken commands: the things you say to the agent that are instructions rather
// than questions.
//
// These are matched before anything reaches a model, for two reasons. They must
// work when the model is slow or down — "stop recording" that depends on an API
// call is not a privacy control. And they must be predictable: a capture verb
// either fired or it did not, with no judgment in between.
//
// Every pattern here requires the wake word in the same utterance. A bare "note
// that down" said between two people is not addressed to the agent, and a
// notebook full of phantom entries destroys trust in the whole record faster
// than missing a real one.

export type CommandKind =
  | 'capture-note'
  | 'capture-decision'
  | 'capture-action'
  | 'status'
  | 'off-the-record'
  | 'on-the-record'
  | 'hush'
  | 'sleep';

export interface SpokenCommand {
  kind: CommandKind;
  /** The words to record, for capture commands: what was said minus the
   *  instruction that wrapped it. Empty means "whatever was just discussed". */
  payload: string;
}

interface Pattern {
  kind: CommandKind;
  /** Capturing group 1, when present, is the payload. */
  match: RegExp;
}

/** English defaults. A deployment in another language replaces the whole set —
 *  translating these one by one produces patterns that fire on ordinary speech,
 *  which is the failure mode that matters. */
export const ENGLISH_COMMANDS: Pattern[] = [
  { kind: 'capture-decision', match: /\b(?:that'?s|thats|mark that as|record that as)\s+(?:a\s+)?decision\b:?\s*(.*)$/i },
  { kind: 'capture-decision', match: /\b(?:log|record|note)\s+(?:this|that)\s+decision\b:?\s*(.*)$/i },
  { kind: 'capture-action', match: /\b(?:that'?s|thats|mark that as|record that as)\s+(?:an?\s+)?(?:action|task|todo)\b:?\s*(.*)$/i },
  { kind: 'capture-action', match: /\b(?:action item|add a task)\b:?\s*(.*)$/i },
  { kind: 'capture-note', match: /\b(?:note|write|take)\s+(?:this|that)\s+down\b:?\s*(.*)$/i },
  { kind: 'capture-note', match: /\b(?:make a note|note that)\b:?\s*(.*)$/i },
  { kind: 'status', match: /\b(?:where are we|what have we (?:decided|got)|catch me up|status|recap)\b/i },
  { kind: 'off-the-record', match: /\b(?:off the record|stop recording|pause recording)\b/i },
  { kind: 'on-the-record', match: /\b(?:on the record|resume recording|start recording)\b/i },
];

export interface CommandOptions {
  wake: RegExp;
  patterns?: Pattern[];
}

/** Reads an utterance as a command, or returns null if it is ordinary speech.
 *
 *  Order matters: the more specific patterns are listed first, so "that's a
 *  decision" is not swallowed by the looser note-taking forms. */
export function readCommand(text: string, opts: CommandOptions): SpokenCommand | null {
  if (!opts.wake.test(text)) return null;

  for (const p of opts.patterns ?? ENGLISH_COMMANDS) {
    const m = text.match(p.match);
    if (!m) continue;
    return { kind: p.kind, payload: cleanPayload(m[1] ?? '', opts.wake) };
  }
  return null;
}

/** Strips the wake word and trailing filler from captured text, so the notebook
 *  holds the content rather than the instruction that carried it. */
function cleanPayload(raw: string, wake: RegExp): string {
  return raw
    .replace(wake, '')
    .replace(/^[\s,:;-]+/, '')
    .replace(/[\s,]+$/, '')
    .trim();
}

/** True when the command changes what gets recorded rather than what gets said.
 *  Used to decide whether a command needs to bypass the floor entirely — you do
 *  not want "stop recording" waiting behind a cooldown. */
export function isRecordingControl(kind: CommandKind): boolean {
  return kind === 'off-the-record' || kind === 'on-the-record';
}
