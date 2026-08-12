// One meeting, from join to minutes.
//
// The loop is deliberately boring: poll the transcript, settle what is new,
// decide, act. All the judgment lives in floor.ts and all the memory in
// notebook.ts, so this file stays readable — which matters, because this is the
// file people will read when they want to know what the agent actually does.

import {
  DEFAULT_FLOOR,
  applyVoiceCommand,
  newFloorState,
  requestFloor,
  shouldYield,
  speechDurationMs,
  turnTaken,
  type FloorConfig,
  type FloorState,
} from './floor';
import { merge, newNotebook, speakableStatus, type Notebook, type NotebookDelta } from './notebook';
import { isRecordingControl, readCommand, type SpokenCommand } from './commands';
import type { Brain, MeetingHandle, Sink, Synthesizer, Transport, Utterance } from '../adapters/contracts';

export interface SessionDeps {
  transport: Transport;
  /** Answers from the conversation itself. Must be fast — a meeting will not
   *  wait, and a late answer is worse than none. */
  fast: Brain;
  /** Allowed to be slow and to use tools. Optional: without it the agent simply
   *  never reaches for outside data. */
  deep?: Brain;
  voice?: Synthesizer;
  sinks: Sink[];
  clock?: () => number;
  log?: (line: string) => void;
}

export interface SessionConfig {
  floor: FloorConfig;
  /** How often to read the transcript. */
  pollMs: number;
  /** How long a segment must stop changing before it counts as final. Transports
   *  re-emit the same offset with better text; acting on the first version means
   *  answering half a sentence. */
  settleMs: number;
  /** A shorter settle once the wake phrase is present: the sentence is already
   *  addressed to us and every second here is felt by a human waiting. */
  settleWhenAddressedMs: number;
  /** How often to fold new transcript into the notebook. */
  notebookMs: number;
  /** How often to hand the record to the sinks while the meeting runs. */
  checkpointMs: number;
  /** Spoken immediately when a slow answer is starting, so the room knows it was
   *  heard. Silence for nine seconds reads as a broken bot. */
  acknowledgements: string[];
  language: string;
  /** Persona and house rules, prepended to every prompt. */
  persona: string;
}

export const DEFAULT_SESSION: Omit<SessionConfig, 'floor' | 'persona'> = {
  pollMs: 1_000,
  settleMs: 4_000,
  settleWhenAddressedMs: 1_200,
  notebookMs: 90_000,
  checkpointMs: 120_000,
  acknowledgements: ['One moment.', 'Let me check.', 'Looking that up.'],
  language: 'en',
};

interface Seen {
  text: string;
  lastChangedAt: number;
  handled: boolean;
}

export interface SessionSnapshot {
  handle: MeetingHandle;
  floor: FloorState;
  notebook: Notebook;
  utterances: Utterance[];
  startedAt: string;
}

/** Marker the model returns instead of an answer when the request needs data it
 *  does not have. Routing, not speech. */
export const NEEDS_DATA = 'NEEDS_DATA';
/** Marker for "this was not addressed to me after all". The floor grants the
 *  right to speak; this is the model declining to use it. */
export const NO_REPLY = 'NO_REPLY';

export class Session {
  private floor: FloorState = newFloorState();
  private book: Notebook = newNotebook();
  private seen = new Map<number, Seen>();
  private utterances: Utterance[] = [];
  private lastNotebookAt = 0;
  private lastCheckpointAt = 0;
  private stopped = false;
  /** Newest question addressed to the agent that the floor turned away. Holding
   *  exactly one is deliberate: a queue would fire three answers in a row after
   *  the cooldown lifts, on top of whatever the room moved on to. The newest
   *  question replaces the older one because the older one is stale. */
  private held: { utterance: Utterance; at: number } | null = null;
  /** While true, nothing is written down. The control has to work without the
   *  model, or "stop recording" is a promise the system cannot keep. */
  private recording = true;
  readonly startedAt: string;

  constructor(
    readonly handle: MeetingHandle,
    private readonly deps: SessionDeps,
    private readonly config: SessionConfig,
  ) {
    this.startedAt = new Date(this.now()).toISOString();
    this.lastNotebookAt = this.now();
    this.lastCheckpointAt = this.now();
  }

  private now(): number {
    return this.deps.clock ? this.deps.clock() : Date.now();
  }

  private log(line: string): void {
    this.deps.log?.(line);
  }

  /** Marks everything already in the transcript as heard without acting on it.
   *
   *  Without this an agent that joins late, or restarts, reads the backlog as
   *  fresh speech and replies to a conversation that ended ten minutes ago. */
  async establishBaseline(): Promise<number> {
    const existing = await this.deps.transport.transcript(this.handle);
    const at = this.now();
    for (const u of existing) {
      this.seen.set(u.offset, { text: u.text, lastChangedAt: at, handled: true });
      this.utterances.push(u);
    }
    this.log(`baseline: ${existing.length} utterances marked as already heard`);
    return existing.length;
  }

  snapshot(): SessionSnapshot {
    return {
      handle: this.handle,
      floor: { ...this.floor },
      notebook: this.book,
      utterances: [...this.utterances],
      startedAt: this.startedAt,
    };
  }

  stop(): void {
    this.stopped = true;
  }

  /** One pass. Returns false when the meeting is over and the loop should end. */
  async tick(): Promise<boolean> {
    if (this.stopped) return false;

    const status = await this.deps.transport.status(this.handle);
    if (status === 'ended' || status === 'failed') {
      this.log(`meeting ${this.handle.id} ${status}`);
      return false;
    }

    const fresh = await this.deps.transport.transcript(this.handle);
    this.absorb(fresh);

    const ready = this.settled();
    for (const u of ready) await this.handle_(u);

    await this.releaseHeld();
    await this.maybeUpdateNotebook();
    await this.maybeCheckpoint();
    return true;
  }

  /** Delivers a question that the floor turned away earlier, if the floor has
   *  since reopened. Dropped rather than delivered once it is older than the
   *  window: answering a question the room has moved past is its own kind of
   *  interruption. */
  private async releaseHeld(): Promise<void> {
    const waiting = this.held;
    if (!waiting) return;

    const at = this.now();
    // Wall clock, not transcript offset: those are different scales, and mixing
    // them made every held question look older than the universe.
    if (at - waiting.at > this.config.floor.windowMs * 2) {
      this.held = null;
      this.log('dropped a held question: too old to be useful');
      return;
    }

    const spoken = { text: waiting.utterance.text, speaker: waiting.utterance.speaker || 'unknown', at };
    const decision = requestFloor(spoken, this.floor, this.config.floor);
    if (!decision.grant) return;

    this.held = null;
    this.floor = decision.state;
    try {
      await this.respond(spoken.text, spoken.speaker);
    } finally {
      this.floor = { ...this.floor, thinkingSince: 0 };
    }
  }

  /** Folds the polled transcript into local state, tracking which offsets are
   *  still changing. */
  private absorb(fresh: Utterance[]): void {
    const at = this.now();
    for (const u of fresh) {
      // Off the record silences the RECORD, not the ears. The agent still has to
      // hear "back on the record" to obey it, so the utterance is tracked for
      // command matching but never joins the transcript we keep, and nothing
      // downstream — notebook, minutes, sinks — can leak it back.
      if (!this.recording) {
        const known = this.seen.get(u.offset);
        if (!known) this.seen.set(u.offset, { text: u.text, lastChangedAt: at, handled: false });
        else if (known.text !== u.text) {
          known.text = u.text;
          known.lastChangedAt = at;
        }
        continue;
      }
      const prev = this.seen.get(u.offset);
      if (!prev) {
        this.seen.set(u.offset, { text: u.text, lastChangedAt: at, handled: false });
        this.utterances.push(u);
        continue;
      }
      if (prev.text !== u.text) {
        prev.text = u.text;
        prev.lastChangedAt = at;
        const known = this.utterances.find((x) => x.offset === u.offset);
        if (known) known.text = u.text;
      }
    }
  }

  /** Utterances that have stopped changing and have not been acted on. */
  private settled(): Utterance[] {
    const at = this.now();
    const out: Utterance[] = [];
    for (const [offset, s] of this.seen) {
      if (s.handled) continue;
      const addressed = this.config.floor.wake.test(s.text);
      const wait = addressed ? this.config.settleWhenAddressedMs : this.config.settleMs;
      if (at - s.lastChangedAt < wait) continue;
      s.handled = true;
      const known = this.utterances.find((x) => x.offset === offset);
      // While off the record there is no stored utterance, but the words still
      // have to reach the command matcher.
      out.push(known ? { ...known, text: s.text } : { offset, text: s.text });
    }
    return out.sort((a, b) => a.offset - b.offset);
  }

  private async handle_(u: Utterance): Promise<void> {
    const at = this.now();
    const spoken = { text: u.text, speaker: u.speaker || 'unknown', at };

    if (shouldYield(spoken, this.floor) && this.deps.transport.stopSpeaking) {
      await this.deps.transport.stopSpeaking(this.handle).catch(() => {});
      this.floor = { ...this.floor, speakingSince: 0 };
    }

    if (await this.tryCommands(u, spoken)) return;
    // Paused: the only thing worth acting on was the resume command, and
    // tryCommands would have caught it.
    if (!this.recording) return;

    const decision = requestFloor(spoken, this.floor, this.config.floor);
    if (!decision.grant) {
      // A question aimed at the agent is never thrown away for timing reasons.
      // It waits, and the next tick delivers it once the floor reopens.
      if (decision.reason === 'cooldown' || decision.reason === 'already-thinking') {
        this.held = { utterance: u, at };
        this.log(`holding a question from ${spoken.speaker} (${decision.reason})`);
      } else if (decision.reason !== 'not-addressed') {
        this.log(`declined the floor: ${decision.reason}`);
      }
      return;
    }

    this.floor = decision.state;
    try {
      await this.respond(spoken.text, spoken.speaker);
    } finally {
      this.floor = { ...this.floor, thinkingSince: 0 };
    }
  }

  /** Handles anything that is an instruction rather than a question. Returns
   *  true when the utterance was consumed and no answer is owed. */
  private async tryCommands(u: Utterance, spoken: { text: string; speaker: string; at: number }): Promise<boolean> {
    // Recording controls jump every queue, including the cooldown: a privacy
    // switch that waits its turn is not a privacy switch.
    const command = readCommand(u.text, { wake: this.config.floor.wake });
    if (command && isRecordingControl(command.kind)) {
      this.recording = command.kind === 'on-the-record';
      this.log(`recording ${this.recording ? 'resumed' : 'paused'} at the request of ${spoken.speaker}`);
      await this.say(this.recording ? 'Recording again.' : 'Off the record.');
      return true;
    }

    const commanded = applyVoiceCommand(spoken, this.floor, this.config.floor);
    if (commanded) {
      this.floor = commanded;
      this.held = null;
      this.log(`voice command from ${spoken.speaker}: floor ${commanded.asleep ? 'asleep' : 'closed'}`);
      return true;
    }

    if (!command) return false;
    await this.runCommand(command, spoken.speaker, u.offset);
    return true;
  }

  /** Explicit capture and status. These bypass the model entirely: what someone
   *  dictated goes down verbatim, and a count of what is settled is arithmetic,
   *  not inference. Both are instant, which is the point — a capture that takes
   *  four seconds gets repeated by the speaker, who assumes it was missed. */
  private async runCommand(command: SpokenCommand, speaker: string, offset: number): Promise<void> {
    if (command.kind === 'status') {
      await this.say(speakableStatus(this.book));
      return;
    }

    // With no dictated content, fall back to what was said immediately before —
    // "make a note" almost always means "of that".
    const content = command.payload || this.previousUtterance(offset);
    if (!content) {
      await this.say('Nothing to note yet.');
      return;
    }

    const delta: NotebookDelta =
      command.kind === 'capture-decision'
        ? { decisions: [{ what: content, by: speaker, at: offset }] }
        : command.kind === 'capture-action'
          ? { actions: [{ what: content, at: offset }] }
          : { questions: [{ what: content, at: offset }] };

    this.book = merge(this.book, delta, this.book.consumedUntil);
    this.log(`captured ${command.kind}: ${content.slice(0, 60)}`);
    await this.say('Noted.');
  }

  private previousUtterance(offset: number): string {
    const before = this.utterances.filter((u) => u.offset < offset);
    return before.length ? (before[before.length - 1]?.text ?? '') : '';
  }

  /** Builds the prompt, routes between the two brains, and speaks the result. */
  private async respond(text: string, speaker: string): Promise<void> {
    const context = this.recentTranscript(40);
    const quick = await this.deps.fast
      .complete({
        system: this.speakingRules(),
        user: addressedPrompt(context, speaker, text),
        maxTokens: 300,
        temperature: 0.6,
      })
      .catch((e) => {
        this.log(`fast brain failed: ${e instanceof Error ? e.message : String(e)}`);
        return NO_REPLY;
      });

    const answer = quick.trim();
    if (!answer || answer.startsWith(NO_REPLY)) {
      this.log('model declined to answer');
      return;
    }

    if (!answer.startsWith(NEEDS_DATA)) {
      await this.say(answer);
      return;
    }

    if (!this.deps.deep) {
      await this.say("I would need to look that up, and I'm not wired to any data here.");
      return;
    }

    // The slow path can take many seconds. Say something first: an unanswered
    // question is indistinguishable from a crashed bot.
    const ack = this.config.acknowledgements[this.floor.turns % this.config.acknowledgements.length];
    await this.say(ack);

    const deep = await this.deps.deep
      .complete({ system: this.speakingRules(), user: addressedPrompt(context, speaker, text), maxTokens: 400 })
      .catch((e) => {
        this.log(`deep brain failed: ${e instanceof Error ? e.message : String(e)}`);
        return '';
      });

    const settled = deep.trim();
    if (!settled || settled.startsWith(NO_REPLY)) return;
    await this.say(settled);
  }

  private async say(text: string): Promise<void> {
    const t = this.now();
    this.floor = turnTaken(this.floor, t, this.config.floor);
    this.log(`speaking (turn ${this.floor.turns}/${this.config.floor.maxTurns}): ${text.slice(0, 80)}`);

    if (this.deps.voice && this.deps.transport.speak) {
      const audio = await this.deps.voice.synthesize(text).catch((e) => {
        this.log(`synthesis failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });
      if (audio) await this.deps.transport.speak(this.handle, audio).catch(() => {});
    } else if (this.deps.transport.postToChat) {
      await this.deps.transport.postToChat(this.handle, text).catch(() => {});
    }

    const done = t + speechDurationMs(text);
    setTimeout(() => {
      if (this.floor.speakingSince && this.floor.speakingSince <= done) {
        this.floor = { ...this.floor, speakingSince: 0 };
      }
    }, speechDurationMs(text));
  }

  private speakingRules(): string {
    return [
      this.config.persona,
      '',
      'You are in a live meeting and everything you write is spoken aloud.',
      'At most two short sentences. No markdown, no lists, no emoji.',
      'Never invent a number: if a figure is not in the transcript, it is not yours to say.',
      `If answering needs data you do not have, reply with exactly: ${NEEDS_DATA}`,
      `If the line was not addressed to you, reply with exactly: ${NO_REPLY}`,
    ].join('\n');
  }

  private recentTranscript(lines: number): string {
    return this.utterances
      .slice(-lines)
      .map((u) => `${u.speaker || 'unknown'}: ${u.text}`)
      .join('\n');
  }

  private async maybeUpdateNotebook(): Promise<void> {
    const at = this.now();
    if (at - this.lastNotebookAt < this.config.notebookMs) return;
    this.lastNotebookAt = at;

    const unread = this.utterances.filter((u) => u.offset > this.book.consumedUntil);
    if (!unread.length) return;

    const last = unread[unread.length - 1].offset;
    const raw = await this.deps.fast
      .complete({
        system: NOTE_TAKER,
        user: unread.map((u) => `[${Math.round(u.offset)}s] ${u.speaker || 'unknown'}: ${u.text}`).join('\n'),
        maxTokens: 900,
        schema: NOTE_SCHEMA,
      })
      .catch((e) => {
        this.log(`note pass failed: ${e instanceof Error ? e.message : String(e)}`);
        return '';
      });

    const delta = parseDelta(raw);
    if (!delta) return;
    this.book = merge(this.book, delta, last);
    this.log(`notes: ${this.book.decisions.length} decisions, ${this.book.actions.length} actions`);
  }

  private async maybeCheckpoint(): Promise<void> {
    const at = this.now();
    if (at - this.lastCheckpointAt < this.config.checkpointMs) return;
    this.lastCheckpointAt = at;
    await this.deliver(true);
  }

  /** Hands the record to every sink. Failures are logged, never thrown: losing a
   *  delivery must not cost the transcript. */
  async deliver(partial: boolean): Promise<void> {
    if (!this.utterances.length) return;
    const record = {
      handle: this.handle,
      title: `Meeting ${this.handle.room}`,
      startedAt: this.startedAt,
      endedAt: partial ? undefined : new Date(this.now()).toISOString(),
      participants: [...new Set(this.utterances.map((u) => u.speaker).filter(Boolean) as string[])],
      utterances: [...this.utterances],
      partial,
    };

    for (const sink of this.deps.sinks) {
      const r = await sink.deliver(record).catch((e) => ({ ok: false, error: String(e) }));
      if (!r.ok) this.log(`sink ${sink.name} failed: ${r.error}`);
    }
  }
}

function addressedPrompt(context: string, speaker: string, text: string): string {
  return [
    'Transcript so far:',
    context,
    '',
    `${speaker} just said: "${text}"`,
    '',
    'Answer only if that line was addressed to you.',
  ].join('\n');
}

const NOTE_TAKER = [
  'You extract structured notes from a meeting transcript excerpt.',
  'Return JSON only, matching the schema. Record only what was actually said.',
  'A decision is something settled, not something discussed.',
  'An action item needs a verb. Include an owner ONLY if a person was named:',
  'an invented owner is worse than a missing one. Same for deadlines.',
  'If the excerpt settled nothing, return empty arrays.',
].join('\n');

const NOTE_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: { type: 'object', required: ['what', 'at'], properties: { what: { type: 'string' }, by: { type: 'string' }, at: { type: 'number' } } },
    },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['what', 'at'],
        properties: { what: { type: 'string' }, owner: { type: 'string' }, due: { type: 'string' }, at: { type: 'number' } },
      },
    },
    questions: {
      type: 'array',
      items: { type: 'object', required: ['what', 'at'], properties: { what: { type: 'string' }, at: { type: 'number' } } },
    },
  },
} as const;

/** Models wrap JSON in prose and fences no matter how firmly you ask them not
 *  to. Salvage the object rather than losing the pass. */
export function parseDelta(raw: string): NotebookDelta | null {
  if (!raw.trim()) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as NotebookDelta;
  } catch {
    return null;
  }
}

export { DEFAULT_FLOOR };
