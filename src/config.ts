// Configuration: one file, plus environment variables for anything secret.
//
// The split is the whole design. The config file describes WHAT you want and is
// safe to commit — providers, models, wake word, where minutes go. Keys live in
// the environment and are referenced by name, never by value. A config file that
// leaks when shared is a config file people keep out of version control, and a
// config nobody commits is a config nobody reviews.

import { readFile } from 'node:fs/promises';
import { DEFAULT_FLOOR } from './core/floor';
import { DEFAULT_SESSION, type SessionConfig } from './core/session';

export interface ProviderRef {
  /** Adapter name. Brains: openai, anthropic, gemini, command. Voices:
   *  elevenlabs, openai, http, none. Anything else is refused when the config is
   *  wired, with the list of what was expected. */
  use: string;
  model?: string;
  voice?: string;
  baseUrl?: string;
  /** NAME of the environment variable holding the key — not the key itself. */
  keyEnv?: string;
  /** For `use: command` — the executable and its arguments. */
  argv?: string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface SinkRef {
  use: 'files' | 'webhook' | 'command' | 'memory';
  dir?: string;
  url?: string;
  tokenEnv?: string;
  argv?: string[];
  /** Deliver checkpoints as well as the finished meeting. Off by default. */
  finalOnly?: boolean;
}

export interface AgentFile {
  /** Name shown in the participant list, and the word that wakes it. */
  name: string;
  /** Extra spellings the recogniser produces for the wake word. Meeting audio
   *  mangles names, and a wake word that only matches its correct spelling
   *  simply never fires. */
  wakeAliases?: string[];
  persona?: string;
  language?: string;

  transport: {
    use: string;
    baseUrl?: string;
    keyEnv?: string;
    speech?: { via: 'api' } | { via: 'redis'; container: string; cli?: string };
  };

  /** Answers from the conversation. Listed in fallback order. */
  fast: ProviderRef[];
  /** Optional: allowed to be slow, reaches for data. */
  deep?: ProviderRef[];
  voice?: ProviderRef[];
  sinks?: SinkRef[];

  floor?: Partial<{
    windowSeconds: number;
    cooldownSeconds: number;
    maxTurns: number;
    followUpSeconds: number;
  }>;

  timing?: Partial<{
    pollSeconds: number;
    settleSeconds: number;
    settleWhenAddressedSeconds: number;
    noteEverySeconds: number;
    checkpointEverySeconds: number;
  }>;
}

export class ConfigError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(hint ? `${message}\n  ${hint}` : message);
    this.name = 'ConfigError';
  }
}

/** Builds the wake pattern.
 *
 *  Word boundaries matter: without them "nova" fires inside "innovation". And
 *  the aliases exist because recognisers mangle names in predictable ways — the
 *  right ones to list are the misspellings you have actually observed in your
 *  transcripts, not everything imaginable. */
export function wakePattern(name: string, aliases: string[] = []): RegExp {
  const forms = [name, ...aliases]
    .map((w) => w.trim())
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!forms.length) throw new ConfigError('the agent needs a name to be woken by');

  // Unicode-aware boundaries rather than \b, which is defined against ASCII word
  // characters: a name like "Ná" or one wrapped in punctuation compiled into a
  // pattern that matched nothing, and the agent simply never woke up.
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${forms.join('|')})(?![\\p{L}\\p{N}])`, 'iu');
  if (!pattern.test(name)) {
    throw new ConfigError(`the name "${name}" cannot be matched as a wake word`, 'use a name made of letters, and put spellings in wakeAliases');
  }
  return pattern;
}

const DEFAULT_PERSONA = [
  'You are a meeting assistant. You listen far more than you talk.',
  'When you do answer, you are brief, concrete and never repeat what was just said.',
].join(' ');

export function toSessionConfig(file: AgentFile): SessionConfig {
  const f = file.floor ?? {};
  const t = file.timing ?? {};
  return {
    floor: {
      ...DEFAULT_FLOOR,
      wake: wakePattern(file.name, file.wakeAliases),
      windowMs: seconds(f.windowSeconds, DEFAULT_FLOOR.windowMs),
      cooldownMs: seconds(f.cooldownSeconds, DEFAULT_FLOOR.cooldownMs),
      followUpMs: seconds(f.followUpSeconds, DEFAULT_FLOOR.followUpMs),
      maxTurns: f.maxTurns ?? DEFAULT_FLOOR.maxTurns,
    },
    pollMs: seconds(t.pollSeconds, DEFAULT_SESSION.pollMs),
    settleMs: seconds(t.settleSeconds, DEFAULT_SESSION.settleMs),
    settleWhenAddressedMs: seconds(t.settleWhenAddressedSeconds, DEFAULT_SESSION.settleWhenAddressedMs),
    notebookMs: seconds(t.noteEverySeconds, DEFAULT_SESSION.notebookMs),
    checkpointMs: seconds(t.checkpointEverySeconds, DEFAULT_SESSION.checkpointMs),
    acknowledgements: DEFAULT_SESSION.acknowledgements,
    language: file.language ?? DEFAULT_SESSION.language,
    persona: file.persona ?? DEFAULT_PERSONA,
  };
}

function seconds(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && value > 0 ? value * 1000 : fallback;
}

/** Reads a key by variable name and fails loudly when it is missing.
 *
 *  Loudly is the point. A silently absent key produces an agent that joins,
 *  listens, and never speaks — a bug that looks like a logic error and takes an
 *  hour to trace back to an unset variable. */
export function readKey(ref: ProviderRef, required = true): string | undefined {
  if (!ref.keyEnv) {
    if (!required) return undefined;
    throw new ConfigError(`provider "${ref.use}" has no keyEnv`, `add keyEnv: "SOME_API_KEY" to the ${ref.use} entry`);
  }
  const value = process.env[ref.keyEnv];
  // Naming a variable is a statement of intent. Empty means the export was
  // forgotten, and letting that through produced an agent that started cleanly
  // and then failed on its first question, in front of everyone.
  if (!value) {
    throw new ConfigError(`environment variable ${ref.keyEnv} is not set`, `export ${ref.keyEnv}=... before starting, or drop keyEnv from the ${ref.use} entry`);
  }
  return value;
}

function assertProviders(file: AgentFile): void {
  if (!file.name?.trim()) throw new ConfigError('config needs a "name"');
  if (!file.transport?.use) throw new ConfigError('config needs a "transport.use"');
  if (typeof file.floor?.maxTurns === 'number' && file.floor.maxTurns < 0) {
    throw new ConfigError('floor.maxTurns cannot be negative', 'use 0 for an agent that never speaks');
  }
  if (!file.fast?.length) {
    throw new ConfigError('config needs at least one "fast" provider', 'fast: [{ use: "gemini", keyEnv: "GEMINI_API_KEY" }]');
  }
}

/** Parses and validates. Accepts JSON, and JSONC with // comments, because a
 *  config people are meant to read should be a config people can annotate. */
/** Removes `//` comments without touching one inside a string. The naive
 *  line-anchored regex only caught comments that began a line, so the trailing
 *  form used throughout the documentation — `"fast": [...],  // the cheap one` —
 *  failed to parse on somebody's first evening with the project. */
export function stripComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (inString) {
      out += ch;
      [inString, escaped] = insideString(ch, escaped);
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

/** Returns [stillInsideTheString, nextCharIsEscaped]. */
function insideString(ch: string, escaped: boolean): [boolean, boolean] {
  if (escaped) return [true, false];
  if (ch === '\\') return [true, true];
  return [ch !== '"', false];
}

export function parseConfig(text: string): AgentFile {
  const stripped = stripComments(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new ConfigError(`config is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const file = parsed as AgentFile;
  assertProviders(file);
  return file;
}

export async function loadConfig(path: string): Promise<AgentFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new ConfigError(`cannot read config at ${path}`, 'run `init` to create one');
  }
  return parseConfig(text);
}

export const EXAMPLE_CONFIG = `{
  // The name is also the wake word. Pick something that is not an ordinary word
  // in your language, or the agent will answer to conversation about other things.
  "name": "Nova",
  "wakeAliases": ["novah", "nowa"],
  "language": "en",
  "persona": "You are the team's meeting assistant. Brief, concrete, never chatty.",

  "transport": {
    "use": "vexa",
    "baseUrl": "http://localhost:18056",
    "keyEnv": "VEXA_API_KEY"
  },

  // Tried in order. The first one that answers wins.
  "fast": [
    { "use": "gemini", "model": "gemini-2.5-flash", "keyEnv": "GEMINI_API_KEY" },
    { "use": "openai", "model": "gpt-4o-mini", "keyEnv": "OPENAI_API_KEY" }
  ],

  // Optional. Slower, and allowed to reach for real data — point it at an agent
  // that already has your tools.
  "deep": [
    { "use": "command", "argv": ["claude", "-p"], "timeoutMs": 120000 }
  ],

  "voice": [
    { "use": "elevenlabs", "keyEnv": "ELEVENLABS_API_KEY" }
  ],

  "sinks": [
    { "use": "files", "dir": "./meetings" }
  ],

  "floor": {
    "windowSeconds": 45,
    "cooldownSeconds": 10,
    "maxTurns": 20
  }
}
`;
