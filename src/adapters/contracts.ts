// The seams. Every external dependency the agent has enters through one of
// these, and nothing below this file knows which implementation is in play.
//
// The rule for adding a seam: it exists because at least two real
// implementations exist today, not because one might exist later. Every
// interface here is backed by two or more shipped adapters, with one exception —
// Transport, where only the Vexa adapter ships and the seam earns its place by
// being the piece most people will need to replace.

/** A finalised piece of speech from the meeting. */
export interface Utterance {
  /** Seconds from the start of the meeting. Also the identity of the segment:
   *  transports re-emit the same offset with better text as recognition
   *  improves, and callers dedupe on it. */
  offset: number;
  text: string;
  /** Display name as the platform reports it. Absent when unattributed. */
  speaker?: string;
  /** Recognition confidence, 0..1, when the provider exposes it. Carried through
   *  for adapters that want it; nothing in the core reads it, and no shipped
   *  transport populates it. */
  confidence?: number;
}

export type MeetingStatus = 'joining' | 'waiting' | 'live' | 'ended' | 'failed';

export interface MeetingHandle {
  /** Stable id for this session, assigned by the transport. */
  id: string;
  /** Room code or URL as the user gave it. */
  room: string;
  platform: string;
}

/** Transport: puts the agent in the room and gets its voice out.
 *
 *  One implementation ships today: a self-hosted browser-bot runner (vexa).
 *  Anything that can produce utterances and optionally play audio can be a
 *  transport — see docs/transports.md for what is worth building next. */
export interface Transport {
  readonly name: string;

  join(room: string, opts: JoinOptions): Promise<MeetingHandle>;
  leave(handle: MeetingHandle): Promise<void>;
  status(handle: MeetingHandle): Promise<MeetingStatus>;

  /** Everything recognised so far, newest last. Callers poll this and dedupe by
   *  offset; a push API would be nicer but no transport offers one reliably. */
  transcript(handle: MeetingHandle): Promise<Utterance[]>;

  /** Play audio into the meeting. Absent on transports that cannot speak —
   *  check for it rather than assuming, a listen-only deployment is valid. */
  speak?(handle: MeetingHandle, audio: SpokenAudio): Promise<void>;

  /** Cut playback immediately. Required whenever speak is present: barge-in is
   *  not optional, it is the difference between a participant and a recording. */
  stopSpeaking?(handle: MeetingHandle): Promise<void>;

  /** Post text into the meeting's chat panel, where available. Silence in the
   *  room, a written trail for everyone else. */
  postToChat?(handle: MeetingHandle, text: string): Promise<void>;

  /** Answer whether the service is reachable and the credentials work, without
   *  joining anything. Used by `check --live`, so an operator finds out at their
   *  desk instead of thirty seconds before a meeting. */
  reachable?(): Promise<void>;
}

export interface JoinOptions {
  /** Name shown in the participant list. */
  displayName: string;
  language?: string;
  /** How long the agent tolerates being alone before leaving, in milliseconds.
   *  Generous by default — a room where everyone is muted looks empty to most
   *  transports — and the Vexa adapter converts to whatever unit its API wants.
   *  Set by a transport's caller in code; there is no config field for it yet. */
  leaveWhenAloneMs?: number;
}

export interface SpokenAudio {
  /** Raw PCM, signed 16-bit little-endian, mono. No container: a WAV header
   *  reaches the virtual microphone as an audible click. */
  pcm: ArrayBuffer;
  sampleRate: number;
}

/** Speech-to-text for transports that hand back audio instead of text. */
export interface Transcriber {
  readonly name: string;
  transcribe(audio: ArrayBuffer, opts: TranscribeOptions): Promise<TranscriptChunk>;
}

export interface TranscribeOptions {
  language?: string;
  /** Passed through to providers that accept one. Note that seeding vocabulary
   *  here backfires on live audio: models echo the prompt during silence. Fix
   *  terminology after recognition instead. */
  prompt?: string;
  signal?: AbortSignal;
}

export interface TranscriptChunk {
  text: string;
  language: string;
  segments: Array<{
    start: number;
    end: number;
    text: string;
    confidence?: number;
  }>;
}

/** Text-to-speech. Returns raw PCM for the same reason as SpokenAudio. */
export interface Synthesizer {
  readonly name: string;
  synthesize(text: string, opts?: { voice?: string; signal?: AbortSignal }): Promise<SpokenAudio>;
}

/** A language model. Two tiers, because a meeting cannot wait for a slow one:
 *  `fast` answers from the conversation, `deep` is allowed to take seconds and
 *  reach for tools. A deployment may point both at the same model. */
export interface Brain {
  readonly name: string;
  complete(req: CompletionRequest): Promise<string>;
}

export interface CompletionRequest {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Response must satisfy this JSON Schema. Providers that cannot enforce it
   *  should still be given the schema in the prompt and validated by the caller. */
  schema?: Record<string, unknown>;
}

/** Where the record ends up. Files on disk are one sink; a chat message, a
 *  ticket, or a webhook are others. Sinks never throw into the meeting loop —
 *  a failed delivery must not cost the transcript. */
export interface Sink {
  readonly name: string;
  deliver(record: MeetingRecord): Promise<DeliveryResult>;
}

export interface DeliveryResult {
  ok: boolean;
  /** Where it landed, for the log and for the user. */
  location?: string;
  error?: string;
}

/** The meeting as delivered to a sink.
 *
 *  `partial: true` means this is a checkpoint written while the meeting is still
 *  running: the title is the room code, the minutes are absent, and a later
 *  record with the same handle supersedes it. */
export interface MeetingRecord {
  handle: MeetingHandle;
  /** Generated from the content once the meeting ends; the room code until then. */
  title: string;
  startedAt: string;
  endedAt?: string;
  participants: string[];
  utterances: Utterance[];
  minutes?: Minutes;
  /** Rendered artefacts, keyed by extension: md, pdf, json. */
  artifacts?: Record<string, string>;
  /** True while the meeting is still running — sinks may want to skip partials. */
  partial: boolean;
}

export interface Minutes {
  title: string;
  summary: string;
  decisions: string[];
  actions: Array<{ what: string; owner?: string; due?: string }>;
  openQuestions: string[];
}
