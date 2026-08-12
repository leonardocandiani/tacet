// Speech-to-text adapters, plus the two corrections that live-meeting audio
// always needs.
//
// The hard-won rule is in `transcribeOptions.prompt`: do not seed vocabulary
// there. On a clean recording it improves proper nouns. On a live meeting it
// makes the model recite the prompt back during silences, and those recitations
// land in the transcript attributed to whoever spoke last. Fix terminology after
// recognition, where the failure mode is a wrong word rather than a fake
// sentence.

import { firstSuccess, type Attempt } from './chain';
import type { TranscribeOptions, Transcriber, TranscriptChunk } from './contracts';

export interface WhisperOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

interface AudioPost {
  url: string;
  headers: Record<string, string>;
  audio: ArrayBuffer;
  model: string;
  opts: TranscribeOptions;
  timeoutMs: number;
}

async function postAudio({ url, headers, audio, model, opts, timeoutMs }: AudioPost): Promise<unknown> {
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', model);
  // verbose_json carries per-segment confidence, and the caller uses it to hold
  // back shaky text. Plain text responses blind that check.
  form.append('response_format', 'verbose_json');
  if (opts.language) form.append('language', opts.language);
  if (opts.prompt) form.append('prompt', opts.prompt);

  const r = await fetch(url, {
    method: 'POST',
    headers,
    body: form,
    signal: opts.signal ?? AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`http ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

interface RawSegment {
  start?: number;
  end?: number;
  text?: string;
  avg_logprob?: number;
  no_speech_prob?: number;
}

/** Whisper reports log-probability and a no-speech estimate; callers want one
 *  number. Mapping avg_logprob through exp gives a rough 0..1 that behaves
 *  sensibly, and multiplying by (1 - no_speech_prob) punishes silence-fill. */
function confidenceOf(s: RawSegment): number | undefined {
  if (typeof s.avg_logprob !== 'number') return undefined;
  const fromLogprob = Math.min(1, Math.exp(s.avg_logprob));
  const speech = typeof s.no_speech_prob === 'number' ? 1 - s.no_speech_prob : 1;
  return Math.max(0, Math.min(1, fromLogprob * speech));
}

function normalise(raw: unknown, fallbackLanguage: string, clean: (t: string) => string): TranscriptChunk {
  const d = raw as { text?: string; language?: string; segments?: RawSegment[] };
  return {
    text: clean(String(d.text ?? '')),
    language: String(d.language ?? fallbackLanguage),
    segments: (d.segments ?? []).map((s) => ({
      start: Number(s.start ?? 0),
      end: Number(s.end ?? 0),
      text: clean(String(s.text ?? '')),
      confidence: confidenceOf(s),
    })),
  };
}

/** Phrases Whisper invents over silence. They are subtitle boilerplate from its
 *  training data, and they arrive looking exactly like speech. Dropping them at
 *  the source keeps them from being attributed to a participant. */
export const COMMON_HALLUCINATIONS: RegExp[] = [
  /subtitles?\s+by/i,
  /amara\.org/i,
  /thanks?\s+for\s+watching/i,
  /subscribe\s+to\s+(the|our)\s+channel/i,
  /^\s*(you|thank you|bye)\s*[.!]?\s*$/i,
  /^\s*\[?\s*(music|applause|silence)\s*\]?\s*$/i,
];

export interface CleanupOptions {
  /** Terms the recogniser reliably mangles, as [wrong, right]. Keep this list
   *  short: every entry is a chance to corrupt correct text. Only add a pattern
   *  whose wrong form is not a real word in your language. */
  corrections?: Array<[RegExp, string]>;
  hallucinations?: RegExp[];
}

export function makeCleaner(opts: CleanupOptions = {}): (text: string) => string {
  const junk = opts.hallucinations ?? COMMON_HALLUCINATIONS;
  const fixes = opts.corrections ?? [];
  return (text: string): string => {
    if (junk.some((re) => re.test(text))) return '';
    return fixes.reduce((t, [wrong, right]) => t.replace(wrong, right), text);
  };
}

/** Any OpenAI-compatible transcription endpoint: OpenAI itself, Groq, or a
 *  self-hosted faster-whisper behind the same route. */
export function whisperTranscriber(opts: WhisperOptions & CleanupOptions = {}): Transcriber {
  const base = opts.baseUrl || 'https://api.openai.com/v1';
  const model = opts.model || 'whisper-1';
  const clean = makeCleaner(opts);
  return {
    name: `whisper:${model}@${new URL(base).host}`,
    async transcribe(audio: ArrayBuffer, o: TranscribeOptions): Promise<TranscriptChunk> {
      if (!opts.apiKey) throw new Error('transcriber needs an API key');
      const raw = await postAudio({
        url: `${base}/audio/transcriptions`,
        headers: { Authorization: `Bearer ${opts.apiKey}` },
        audio,
        model,
        opts: o,
        timeoutMs: opts.timeoutMs ?? 25_000,
      });
      const out = normalise(raw, o.language || 'en', clean);
      if (!out.text.trim()) throw new Error('transcriber returned nothing usable');
      return out;
    },
  };
}

/** Groq hosts Whisper at OpenAI-compatible routes and is fast enough that you
 *  can afford a longer audio window — which matters more for quality than the
 *  model choice does. See docs/audio-windows.md. */
export function groqTranscriber(opts: WhisperOptions & CleanupOptions = {}): Transcriber {
  return whisperTranscriber({
    ...opts,
    baseUrl: opts.baseUrl || 'https://api.groq.com/openai/v1',
    model: opts.model || 'whisper-large-v3-turbo',
  });
}

/** Walks a list of transcribers until one returns usable text. */
export function transcriberChain(
  transcribers: Transcriber[],
  onFail?: (name: string, error: string) => void,
): Transcriber {
  if (!transcribers.length) throw new Error('a transcriber chain needs at least one transcriber');
  return {
    name: `chain(${transcribers.map((t) => t.name).join(' → ')})`,
    async transcribe(audio: ArrayBuffer, o: TranscribeOptions): Promise<TranscriptChunk> {
      const attempts: Array<Attempt<TranscriptChunk>> = transcribers.map((t) => ({
        name: t.name,
        run: () => t.transcribe(audio, o),
      }));
      const { value } = await firstSuccess(attempts, { onFail, accept: (v) => v.text.trim().length > 0 });
      return value;
    },
  };
}
