// Where the record ends up.
//
// Sinks are the reason this project is useful rather than merely interesting: a
// transcript nobody receives is a transcript nobody reads. Every sink here obeys
// two rules. It never throws into the meeting loop, and it treats a partial
// record — one delivered mid-meeting — as something to update, not to duplicate.

import { redact } from '../redact';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeliveryResult, MeetingRecord, Sink } from './contracts';

/** Filesystem-safe name from a title: no accents, no separators, bounded. */
/** Anything that reaches a path segment goes through here. A room code arrives
 *  from the command line and a title from a language model; neither is trusted to
 *  stay inside the meetings directory on its own. */
export function safeSegment(raw: string, fallback: string): string {
  const cleaned = slug(raw);
  return cleaned || fallback;
}

export function slug(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function transcriptMarkdown(record: MeetingRecord): string {
  const lines: string[] = [];
  let last = '';
  for (const u of record.utterances) {
    const text = u.text.trim();
    if (!text) continue;
    const who = u.speaker || 'unknown';
    // Group consecutive turns by the same person. A transcript split at every
    // recognised phrase is accurate and unreadable.
    if (who === last) lines[lines.length - 1] += ` ${text}`;
    else {
      lines.push(`**${who}:** ${text}`);
      last = who;
    }
  }
  return lines.join('\n\n');
}

export function renderMarkdown(record: MeetingRecord): string {
  const head = [
    `# ${record.title}`,
    '',
    `- Room: ${record.handle.room}`,
    `- Started: ${record.startedAt}`,
    `- Participants: ${record.participants.join(', ') || 'not identified'}`,
    `- Utterances: ${record.utterances.length}`,
    `- State: ${record.partial ? 'in progress (partial record)' : 'ended'}`,
    '',
  ];

  const m = record.minutes;
  if (m) {
    head.push(
      '## Summary',
      '',
      m.summary,
      '',
      '## Decisions',
      '',
      m.decisions.length ? m.decisions.map((d) => `- ${d}`).join('\n') : 'Nothing was settled.',
      '',
      '## Action items',
      '',
      m.actions.length
        ? m.actions.map((a) => `- ${a.what}${a.owner ? ` — ${a.owner}` : ''}${a.due ? ` — ${a.due}` : ''}`).join('\n')
        : 'None recorded.',
      '',
      '## Open questions',
      '',
      m.openQuestions.length ? m.openQuestions.map((q) => `- ${q}`).join('\n') : 'None left open.',
      '',
    );
  }

  return `${head.join('\n')}\n---\n\n## Transcript\n\n${transcriptMarkdown(record)}\n`;
}

export interface FileSinkOptions {
  /** Root directory. One folder per meeting is created underneath. */
  dir: string;
  /** Also write the raw record as JSON, for anything downstream. */
  json?: boolean;
}

/** Writes the record to disk. The default sink, and the one that makes a crash
 *  survivable: it runs on every checkpoint, not only at the end. */
export function fileSink(opts: FileSinkOptions): Sink {
  return {
    name: 'files',
    async deliver(record: MeetingRecord): Promise<DeliveryResult> {
      const day = record.startedAt.slice(0, 10);
      const name = safeSegment(record.title, safeSegment(record.handle.room, 'meeting'));
      const dir = join(opts.dir, `${day}_${name}`);
      try {
        await mkdir(dir, { recursive: true });
        await Bun.write(join(dir, 'transcript.md'), renderMarkdown(record));
        if (opts.json !== false) {
          await Bun.write(join(dir, 'meeting.json'), JSON.stringify(record, null, 2));
        }
        for (const [ext, content] of Object.entries(record.artifacts || {})) {
          if (ext === 'pdf') continue; // written by the renderer, not copied through JSON
          if (!/^[a-z0-9]{1,8}$/i.test(ext)) continue;
          await Bun.write(join(dir, `minutes.${ext}`), content);
        }
        return { ok: true, location: dir };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export interface WebhookSinkOptions {
  url: string;
  /** Sent as a bearer token when present. */
  token?: string;
  headers?: Record<string, string>;
  /** Skip partial records. Defaults to **true**: most integrations want the
   *  finished meeting, and a checkpoint every few minutes turns a Slack channel
   *  into a stream of drafts. Set false to receive them. */
  finalOnly?: boolean;
  timeoutMs?: number;
}

/** POSTs the record as JSON. The seam for Slack relays, ticket systems, an
 *  internal API, or n8n. */
export function webhookSink(opts: WebhookSinkOptions): Sink {
  return {
    name: `webhook:${new URL(opts.url).host}`,
    async deliver(record: MeetingRecord): Promise<DeliveryResult> {
      if (opts.finalOnly !== false && record.partial) return { ok: true, location: 'skipped (partial)' };
      try {
        const r = await fetch(opts.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
            ...opts.headers,
          },
          body: JSON.stringify(record),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
        });
        if (!r.ok) return { ok: false, error: `http ${r.status}` };
        return { ok: true, location: opts.url };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export interface CommandSinkOptions {
  /** Executable and arguments. The record arrives on stdin as JSON. */
  argv: string[];
  cwd?: string;
  finalOnly?: boolean;
  timeoutMs?: number;
}

/** Pipes the record into a command. The most flexible sink: send it to your own
 *  script and do whatever your organisation actually needs — file a ticket,
 *  message a channel, append to a wiki. */
export function commandSink(opts: CommandSinkOptions): Sink {
  return {
    name: `command:${opts.argv[0]}`,
    async deliver(record: MeetingRecord): Promise<DeliveryResult> {
      if (opts.finalOnly !== false && record.partial) return { ok: true, location: 'skipped (partial)' };
      try {
        const proc = Bun.spawn(opts.argv, {
          cwd: opts.cwd,
          stdin: new TextEncoder().encode(JSON.stringify(record)),
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const code = await proc.exited;
        if (code !== 0) {
          const err = await new Response(proc.stderr).text();
          return { ok: false, error: `exited ${code}: ${redact(err).slice(0, 200)}` };
        }
        return { ok: true, location: opts.argv.join(' ') };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/** Keeps records in memory. For tests, and for embedding the library in a
 *  process that wants to handle delivery itself. */
export function memorySink(): Sink & { records: MeetingRecord[] } {
  const records: MeetingRecord[] = [];
  return {
    name: 'memory',
    records,
    async deliver(record: MeetingRecord): Promise<DeliveryResult> {
      records.push(record);
      return { ok: true, location: 'memory' };
    },
  };
}
