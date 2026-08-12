// Language model adapters.
//
// Four of them, and the fourth is the interesting one: `command` shells out to a
// CLI. That is how you attach an agent that already has your tools and your
// context — Claude Code, Codex, an in-house script — without this project
// needing to know anything about them.

import { firstSuccess, withDeadline, type Attempt } from './chain';
import type { Brain, CompletionRequest } from './contracts';

const DEFAULT_TIMEOUT_MS = 25_000;

function requireKey(key: string | undefined, provider: string): string {
  if (!key) throw new Error(`${provider} needs an API key`);
  return key;
}

/** The OpenAI chat body, shared by every provider that speaks its dialect. */
function chatPayload(model: string, req: CompletionRequest): Record<string, unknown> {
  return {
    model,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ],
    max_tokens: req.maxTokens ?? 400,
    temperature: req.temperature ?? 0.6,
    ...(req.schema ? { response_format: { type: 'json_object' } } : {}),
  };
}

export interface HttpBrainOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/** OpenAI chat completions, and anything that speaks its dialect — vLLM,
 *  Ollama, OpenRouter, LM Studio. Point baseUrl at it and it works. */
export function openaiBrain(opts: HttpBrainOptions = {}): Brain {
  const base = opts.baseUrl || 'https://api.openai.com/v1';
  const model = opts.model || 'gpt-4o-mini';
  return {
    name: `openai:${model}`,
    async complete(req: CompletionRequest): Promise<string> {
      const r = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${requireKey(opts.apiKey, 'openai')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(chatPayload(model, req)),
        signal: req.signal ?? AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!r.ok) throw new Error(`openai http ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const d = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return String(d.choices?.[0]?.message?.content ?? '').trim();
    },
  };
}

/** Anthropic messages API. */
export function anthropicBrain(opts: HttpBrainOptions = {}): Brain {
  const base = opts.baseUrl || 'https://api.anthropic.com/v1';
  const model = opts.model || 'claude-sonnet-5';
  return {
    name: `anthropic:${model}`,
    async complete(req: CompletionRequest): Promise<string> {
      const r = await fetch(`${base}/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': requireKey(opts.apiKey, 'anthropic'),
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
          max_tokens: req.maxTokens ?? 400,
          temperature: req.temperature ?? 0.6,
        }),
        signal: req.signal ?? AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!r.ok) throw new Error(`anthropic http ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const d = (await r.json()) as { content?: Array<{ text?: string }> };
      return String(d.content?.[0]?.text ?? '').trim();
    },
  };
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
}

/** An empty answer with a finishReason is a real failure — usually MAX_TOKENS,
 *  where the thinking budget consumed the response. Surfacing it as an error is
 *  what lets the fallback chain move on instead of returning silence. */
function readGeminiText(raw: unknown): string {
  const c = (raw as GeminiResponse).candidates?.[0];
  const text = String(c?.content?.parts?.[0]?.text ?? '').trim();
  if (!text && c?.finishReason) throw new Error(`gemini returned nothing (${c.finishReason})`);
  return text;
}

/** Google Gemini. Note the thinking budget: on 2.5-flash, reasoning is drawn
 *  from the same allowance as the answer, so an unbounded budget silently
 *  truncates long output. Minutes cut off mid-sentence are how we learned. */
export function geminiBrain(opts: HttpBrainOptions & { thinkingBudget?: number } = {}): Brain {
  const model = opts.model || 'gemini-2.5-flash';
  const base = opts.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
  return {
    name: `gemini:${model}`,
    async complete(req: CompletionRequest): Promise<string> {
      const key = requireKey(opts.apiKey, 'gemini');
      const r = await fetch(`${base}/models/${model}:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ parts: [{ text: req.user }] }],
          generationConfig: {
            maxOutputTokens: req.maxTokens ?? 400,
            temperature: req.temperature ?? 0.6,
            thinkingConfig: { thinkingBudget: opts.thinkingBudget ?? 512 },
            ...(req.schema ? { responseMimeType: 'application/json' } : {}),
          },
        }),
        signal: req.signal ?? AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!r.ok) throw new Error(`gemini http ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return readGeminiText(await r.json());
    },
  };
}

export interface CommandBrainOptions {
  /** Executable and its fixed arguments, e.g. ["claude", "-p"]. */
  argv: string[];
  /** Extra arguments appended after the prompt. */
  trailing?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** How the prompt reaches the process. Most CLIs prefer stdin. */
  via?: 'stdin' | 'arg';
}

/** Runs a local command and treats its stdout as the answer.
 *
 *  This is the escape hatch that makes the project useful inside a company: the
 *  agent you already trust with your data answers the question, and this project
 *  only handles getting it into and out of the room. Expect it to be slow —
 *  route it as the deep brain and let something fast cover the conversation. */
export function commandBrain(opts: CommandBrainOptions): Brain {
  return {
    name: `command:${opts.argv[0]}`,
    async complete(req: CompletionRequest): Promise<string> {
      const prompt = `${req.system}\n\n---\n\n${req.user}`;
      const argv = [...opts.argv, ...(opts.via === 'arg' ? [prompt] : []), ...(opts.trailing || [])];

      const proc = Bun.spawn(argv, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        stdin: opts.via === 'arg' ? 'ignore' : new TextEncoder().encode(prompt),
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const done = (async () => {
        const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        if (code !== 0) {
          const err = await new Response(proc.stderr).text();
          throw new Error(`${opts.argv[0]} exited ${code}: ${err.slice(0, 200)}`);
        }
        return out.trim();
      })();

      try {
        return await withDeadline(done, opts.timeoutMs ?? 120_000, opts.argv[0]);
      } catch (err) {
        // Deadline reached and the process is still going: kill it, or a slow
        // CLI accumulates children for the length of the meeting.
        proc.kill();
        throw err;
      }
    },
  };
}

/** Tries each brain in order and returns the first usable answer. */
export function brainChain(brains: Brain[], onFail?: (name: string, error: string) => void): Brain {
  if (!brains.length) throw new Error('a brain chain needs at least one brain');
  return {
    name: `chain(${brains.map((b) => b.name).join(' → ')})`,
    async complete(req: CompletionRequest): Promise<string> {
      const attempts: Array<Attempt<string>> = brains.map((b) => ({
        name: b.name,
        run: () => b.complete(req),
      }));
      const { value } = await firstSuccess(attempts, {
        onFail,
        accept: (v) => v.trim().length > 0,
      });
      return value;
    },
  };
}
