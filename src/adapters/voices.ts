// Text-to-speech adapters.
//
// All of them return raw PCM with no container. That is not an oversight: the
// audio goes into a virtual microphone, and a WAV header arriving mid-stream is
// audible in the room as a click at the start of every sentence.

import { redact } from '../redact';
import { firstSuccess } from './chain';
import type { SpokenAudio, Synthesizer } from './contracts';

const SAMPLE_RATE = 24_000;

export interface VoiceOptions {
  apiKey?: string;
  voice?: string;
  model?: string;
  timeoutMs?: number;
}

/** ElevenLabs streaming. The flash models exist for exactly this use: a meeting
 *  notices a second of latency and does not notice the last few percent of
 *  naturalness. */
export function elevenLabsVoice(opts: VoiceOptions = {}): Synthesizer {
  const voice = opts.voice || 'EXAVITQu4vr4xnSDxMaL';
  const model = opts.model || 'eleven_flash_v2_5';
  return {
    name: `elevenlabs:${model}`,
    async synthesize(text: string, o = {}): Promise<SpokenAudio> {
      if (!opts.apiKey) throw new Error('elevenlabs needs an API key');
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${o.voice || voice}/stream?output_format=pcm_${SAMPLE_RATE}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'xi-api-key': opts.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: model }),
        signal: o.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      });
      if (!r.ok) throw new Error(`elevenlabs http ${r.status}: ${redact(await r.text()).slice(0, 200)}`);
      const pcm = await r.arrayBuffer();
      if (!pcm.byteLength) throw new Error('elevenlabs returned no audio');
      return { pcm, sampleRate: SAMPLE_RATE };
    },
  };
}

/** OpenAI speech. Asks for pcm explicitly for the same header reason. */
export function openaiVoice(opts: VoiceOptions = {}): Synthesizer {
  const voice = opts.voice || 'alloy';
  const model = opts.model || 'gpt-4o-mini-tts';
  return {
    name: `openai:${model}`,
    async synthesize(text: string, o = {}): Promise<SpokenAudio> {
      if (!opts.apiKey) throw new Error('openai needs an API key');
      const r = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, voice: o.voice || voice, input: text, response_format: 'pcm' }),
        signal: o.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      });
      if (!r.ok) throw new Error(`openai tts http ${r.status}: ${redact(await r.text()).slice(0, 200)}`);
      const pcm = await r.arrayBuffer();
      if (!pcm.byteLength) throw new Error('openai returned no audio');
      // OpenAI's pcm is 24 kHz mono s16le, same shape as the rest.
      return { pcm, sampleRate: SAMPLE_RATE };
    },
  };
}

/** Any HTTP endpoint that takes {text} and returns raw PCM. The seam for a
 *  local Piper or Coqui, which is what you want when nothing may leave the
 *  building. */
export function httpVoice(url: string, opts: VoiceOptions & { token?: string } = {}): Synthesizer {
  // `token` is the older spelling and wire.ts passes `apiKey`. Accepting both is
  // one line; accepting neither meant every custom endpoint saw an unauthenticated
  // request and the operator had no way to tell from the config that it would.
  const key = opts.apiKey ?? opts.token;
  return {
    name: `http:${new URL(url).host}`,
    async synthesize(text: string, o = {}): Promise<SpokenAudio> {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({ text, voice: o.voice || opts.voice }),
        signal: o.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      });
      if (!r.ok) throw new Error(`voice http ${r.status}`);
      const pcm = await r.arrayBuffer();
      if (!pcm.byteLength) throw new Error('voice endpoint returned no audio');
      return { pcm, sampleRate: SAMPLE_RATE };
    },
  };
}

/** Says nothing, successfully. For listen-only deployments and for tests. */
export function silentVoice(): Synthesizer {
  return {
    name: 'silent',
    async synthesize(): Promise<SpokenAudio> {
      return { pcm: new ArrayBuffer(0), sampleRate: SAMPLE_RATE };
    },
  };
}

/** Tries each voice in turn, exactly like the brain chain. Configuration takes a
 *  list, the documentation calls it a fallback, and until this existed only the
 *  first entry was ever built — so an ElevenLabs outage silenced an agent that
 *  had OpenAI configured right underneath it. */
export function voiceChain(voices: Synthesizer[], onFail?: (name: string, error: string) => void): Synthesizer {
  if (!voices.length) throw new Error('a voice chain needs at least one voice');
  if (voices.length === 1) return voices[0] as Synthesizer;

  return {
    name: `chain(${voices.map((v) => v.name).join(' → ')})`,
    async synthesize(text: string, opts = {}): Promise<SpokenAudio> {
      const { value } = await firstSuccess(
        voices.map((v) => ({ name: v.name, run: () => v.synthesize(text, opts) })),
        { onFail, accept: (a: SpokenAudio) => a.pcm.byteLength > 0 },
      );
      return value;
    },
  };
}
