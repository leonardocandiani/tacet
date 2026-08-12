// Turning a config file into working parts.
//
// One switch per seam, and each unknown name fails with the list of names that
// would have worked. Nothing here is clever: this file is meant to be the
// boring, obvious answer to "how do I add a provider?".

import { ConfigError, readKey, type AgentFile, type ProviderRef, type SinkRef } from './config';
import { anthropicBrain, brainChain, commandBrain, geminiBrain, openaiBrain } from './adapters/brains';
import { elevenLabsVoice, httpVoice, openaiVoice, silentVoice } from './adapters/voices';
import { commandSink, fileSink, memorySink, webhookSink } from './adapters/sinks';
import { vexaTransport } from './adapters/transports/vexa';
import type { Brain, Sink, Synthesizer, Transport } from './adapters/contracts';

const BRAINS = ['openai', 'anthropic', 'gemini', 'command'] as const;
const VOICES = ['elevenlabs', 'openai', 'http', 'silent'] as const;
const SINKS = ['files', 'webhook', 'command', 'memory'] as const;
const TRANSPORTS = ['vexa'] as const;

function unknown(kind: string, got: string, known: readonly string[]): never {
  throw new ConfigError(`unknown ${kind} "${got}"`, `known ${kind}s: ${known.join(', ')}`);
}

/** Reads an optional env var by name, failing loudly when the name is given but
 *  the variable is not set — the silent version of this bug looks like an agent
 *  that joins and never works. */
function envValue(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const value = process.env[name];
  if (!value) throw new ConfigError(`environment variable ${name} is not set`, `export ${name}=... before starting`);
  return value;
}

export function makeBrain(ref: ProviderRef): Brain {
  switch (ref.use) {
    case 'openai':
      return openaiBrain({ apiKey: readKey(ref), model: ref.model, baseUrl: ref.baseUrl, timeoutMs: ref.timeoutMs });
    case 'anthropic':
      return anthropicBrain({ apiKey: readKey(ref), model: ref.model, baseUrl: ref.baseUrl, timeoutMs: ref.timeoutMs });
    case 'gemini':
      return geminiBrain({ apiKey: readKey(ref), model: ref.model, baseUrl: ref.baseUrl, timeoutMs: ref.timeoutMs });
    case 'command':
      if (!ref.argv?.length) throw new ConfigError('a command provider needs "argv"', 'argv: ["claude", "-p"]');
      return commandBrain({ argv: ref.argv, cwd: ref.cwd, timeoutMs: ref.timeoutMs });
    default:
      return unknown('brain', ref.use, BRAINS);
  }
}

export function makeVoice(ref: ProviderRef): Synthesizer {
  switch (ref.use) {
    case 'elevenlabs':
      return elevenLabsVoice({ apiKey: readKey(ref), voice: ref.voice, model: ref.model, timeoutMs: ref.timeoutMs });
    case 'openai':
      return openaiVoice({ apiKey: readKey(ref), voice: ref.voice, model: ref.model, timeoutMs: ref.timeoutMs });
    case 'http':
      if (!ref.baseUrl) throw new ConfigError('an http voice needs "baseUrl"');
      return httpVoice(ref.baseUrl, { apiKey: readKey(ref, false), voice: ref.voice, timeoutMs: ref.timeoutMs });
    case 'silent':
      return silentVoice();
    default:
      return unknown('voice', ref.use, VOICES);
  }
}

export function makeSink(ref: SinkRef): Sink {
  switch (ref.use) {
    case 'files':
      if (!ref.dir) throw new ConfigError('a files sink needs "dir"', 'dir: "./meetings"');
      return fileSink({ dir: ref.dir });
    case 'webhook':
      if (!ref.url) throw new ConfigError('a webhook sink needs "url"');
      return webhookSink({ url: ref.url, token: envValue(ref.tokenEnv), finalOnly: ref.finalOnly });
    case 'command':
      if (!ref.argv?.length) throw new ConfigError('a command sink needs "argv"');
      return commandSink({ argv: ref.argv, finalOnly: ref.finalOnly });
    case 'memory':
      return memorySink();
    default:
      return unknown('sink', ref.use, SINKS);
  }
}

export function makeTransport(file: AgentFile): Transport {
  const t = file.transport;
  switch (t.use) {
    case 'vexa':
      if (!t.baseUrl) throw new ConfigError('the vexa transport needs "baseUrl"');
      return vexaTransport({ baseUrl: t.baseUrl, apiKey: envValue(t.keyEnv) ?? '', speech: t.speech });
    default:
      return unknown('transport', t.use, TRANSPORTS);
  }
}

export interface WiredAgent {
  transport: Transport;
  fast: Brain;
  deep?: Brain;
  voice?: Synthesizer;
  sinks: Sink[];
}

/** Builds everything the session needs. Throws ConfigError with a usable hint on
 *  the first thing that is wrong, rather than starting and failing mid-meeting. */
export function wire(file: AgentFile, log?: (line: string) => void): WiredAgent {
  const onFail = log ? (name: string, error: string) => log(`provider ${name} failed: ${error}`) : undefined;

  return {
    transport: makeTransport(file),
    fast: brainChain(file.fast.map(makeBrain), onFail),
    deep: file.deep?.length ? brainChain(file.deep.map(makeBrain), onFail) : undefined,
    voice: file.voice?.length ? makeVoice(file.voice[0] as ProviderRef) : undefined,
    sinks: (file.sinks ?? []).map(makeSink),
  };
}
