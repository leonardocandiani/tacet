#!/usr/bin/env bun
// The command line. Four verbs and no flags worth memorising.

import { EXAMPLE_CONFIG, loadConfig, toSessionConfig, ConfigError } from './config';
import { Session } from './core/session';
import { wire } from './wire';
import { parseGoogleMeetRoom } from './adapters/transports/vexa';
import { writeMinutes, type DraftedMinutes } from './core/minutes';
import { renderPdf } from './render/pdf';
import { renderMarkdown, safeSegment, slug } from './adapters/sinks';
import type { MeetingRecord } from './adapters/contracts';
import { redact } from './redact';
import { join } from 'node:path';
import { mkdir, rename } from 'node:fs/promises';

const NAME = 'tacet';

const USAGE = `${NAME} — silent by default

  ${NAME} init [path]           write an example config next to you
  ${NAME} join <room|url>       join a meeting and stay until it ends
  ${NAME} check [--live]        verify the config; --live also calls every provider
  ${NAME} version

Options
  --config <path>   default: ./${NAME}.json
  --quiet           only errors
  --live            with check: really call each brain, voice and transport
`;

interface Args {
  command: string;
  positional: string[];
  config: string;
  quiet: boolean;
  live: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let config = `./${NAME}.json`;
  let quiet = false;
  let live = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') config = argv[++i] ?? config;
    else if (a === '--quiet') quiet = true;
    else if (a === '--live') live = true;
    else if (a?.startsWith('-')) throw new Error(`unknown option ${a}`);
    else if (a) positional.push(a);
  }

  return { command: positional.shift() ?? 'help', positional, config, quiet, live };
}

const stamp = () => new Date().toISOString().slice(11, 19);

async function cmdInit(path: string): Promise<number> {
  if (await Bun.file(path).exists()) {
    console.error(`${path} already exists — not overwriting it`);
    return 1;
  }
  await Bun.write(path, EXAMPLE_CONFIG);
  console.log(`wrote ${path}`);
  console.log('Edit the name, then export the API keys it references.');
  return 0;
}

/** One provider, actually called. Returns null when it worked, the reason when
 *  it did not — HTTP 200 with an unusable body counts as not working. */
async function probe(what: string, run: () => Promise<unknown>): Promise<string | null> {
  const started = Date.now();
  try {
    await run();
    process.stdout.write(`  ${what}: ok (${Date.now() - started}ms)\n`);
    return null;
  } catch (err) {
    // Providers answer failures with whole JSON documents. One line each, or the
    // report is unreadable exactly when something is wrong.
    const reason = redact(err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 160);
    process.stdout.write(`  ${what}: FAILED — ${reason}\n`);
    return `${what}: ${reason}`;
  }
}

/** Calls every provider the config names. Cheap on purpose — a dozen tokens and
 *  one short word of audio — but real: this is the difference between "the file
 *  parses" and "this will work at ten o'clock tomorrow". */
async function checkLive(agent: ReturnType<typeof wire>): Promise<string[]> {
  console.log('\nlive checks');
  const failures: Array<string | null> = [];

  if (agent.transport.reachable) {
    failures.push(await probe(`transport ${agent.transport.name}`, () => agent.transport.reachable?.() ?? Promise.resolve()));
  }

  const ping = { system: 'Reply with the single word: ok', user: 'Say ok.', maxTokens: 8 };
  failures.push(
    await probe(`fast ${agent.fast.name}`, async () => {
      const answer = await agent.fast.complete(ping);
      if (!answer.trim()) throw new Error('answered with nothing');
    }),
  );

  if (agent.deep) {
    failures.push(
      await probe(`deep ${agent.deep.name}`, async () => {
        const answer = await agent.deep?.complete(ping);
        if (!answer?.trim()) throw new Error('answered with nothing');
      }),
    );
  }

  // The silent voice returns nothing on purpose, and a listen-only deployment
  // failing its own check would teach people to ignore the check.
  if (agent.voice && agent.voice.name !== 'silent') {
    failures.push(
      await probe(`voice ${agent.voice.name}`, async () => {
        const audio = await agent.voice?.synthesize('ok');
        if (!audio?.pcm.byteLength) throw new Error('returned no audio');
      }),
    );
  }

  return failures.filter((f): f is string => Boolean(f));
}

function describe(
  configPath: string,
  name: string,
  agent: ReturnType<typeof wire>,
  session: ReturnType<typeof toSessionConfig>,
): void {
  console.log(`config      ${configPath}`);
  console.log(`agent       ${name}`);
  console.log(`wakes on    ${session.floor.wake}`);
  console.log(`transport   ${agent.transport.name}`);
  console.log(`fast        ${agent.fast.name}`);
  console.log(`deep        ${agent.deep?.name ?? '(none — it will never look anything up)'}`);
  console.log(`voice       ${agent.voice?.name ?? '(none — it will use the meeting chat)'}`);
  console.log(`sinks       ${agent.sinks.map((s) => s.name).join(', ') || '(none — nothing will be saved)'}`);
  console.log(`floor       window ${session.floor.windowMs / 1000}s · cooldown ${session.floor.cooldownMs / 1000}s · max ${session.floor.maxTurns} turns`);
  if (!session.floor.maxTurns) console.log('            (a budget of zero: it will never speak, not even to confirm)');
}

async function cmdCheck(configPath: string, live: boolean): Promise<number> {
  const file = await loadConfig(configPath);
  const agent = wire(file);
  const session = toSessionConfig(file);

  describe(configPath, file.name, agent, session);

  // A wake word that matches ordinary speech is the single most damaging
  // misconfiguration: the agent interrupts a meeting it was never called into.
  const ordinary = ['the', 'and', 'yes', 'no', 'ok', 'so', 'well', 'right', 'sure', 'now', 'hey'];
  const clash = ordinary.find((w) => session.floor.wake.test(w));
  if (clash) {
    console.error(`\n!  the wake word matches the ordinary word "${clash}" — it will speak uninvited`);
    return 1;
  }

  if (!live) {
    console.log('\nconfig and credentials look usable. No provider was called —');
    console.log(`run \`${NAME} check --live\` to make each one answer for itself.`);
    return 0;
  }

  const failures = await checkLive(agent);
  if (failures.length) {
    console.error(`\n${failures.length} provider${failures.length > 1 ? 's' : ''} did not answer.`);
    return 1;
  }
  console.log('\neverything answered.');
  return 0;
}

type Snapshot = ReturnType<Session['snapshot']>;

function buildRecord(snap: Snapshot, title: string, minutes: DraftedMinutes['minutes'] | undefined): MeetingRecord {
  return {
    handle: snap.handle,
    title,
    startedAt: snap.startedAt,
    endedAt: new Date().toISOString(),
    participants: [...new Set(snap.utterances.map((u) => u.speaker).filter(Boolean) as string[])],
    utterances: snap.utterances,
    minutes,
    partial: false,
  };
}

async function writePdf(record: MeetingRecord, body: string | undefined, destination: string, log: (l: string) => void): Promise<void> {
  await renderPdf(
    {
      title: record.title,
      meta: [
        new Date(record.startedAt).toLocaleString(),
        `${record.utterances.length} utterances`,
        record.participants.join(', ') || 'participants not identified',
      ],
      body: body ?? '## Summary\n\nNo minutes were generated.',
      transcript: renderMarkdown({ ...record, minutes: undefined }).split('## Transcript')[1] ?? '',
      footer: `Recorded by ${NAME}`,
    },
    destination,
    { log },
  );
}

/** Where the checkpoints have been landing all meeting: the title does not exist
 *  until the end, so the room code is the only stable name available. */
export function checkpointFolder(dir: string, day: string, room: string): string {
  return join(dir, `${day}_${slug(`Meeting ${room}`)}`);
}

/** The room code comes off the command line and the title out of a model. Both
 *  end up as a directory name, so both are reduced to a single safe segment —
 *  `join` would happily follow `../..` out of the meetings folder. */
function folderName(day: string, title: string, room: string): string {
  return `${day}_${safeSegment(title, safeSegment(room, 'meeting'))}`;
}

/** Rename the checkpoint folder to the title rather than creating a second one,
 *  or every meeting leaves an orphan behind holding a half-written transcript. */
async function openFolder(dir: string, day: string, room: string, title: string): Promise<string> {
  const checkpointed = checkpointFolder(dir, day, room);
  const folder = join(dir, folderName(day, title, room));
  if (folder === checkpointed) {
    await mkdir(folder, { recursive: true });
    return folder;
  }

  const started = await Bun.file(join(checkpointed, 'transcript.md')).exists();
  const taken = started && (await Bun.file(join(folder, 'transcript.md')).exists());
  if (started && !taken) {
    await rename(checkpointed, folder).catch(() => {});
  }
  await mkdir(folder, { recursive: true });
  return folder;
}

async function finish(session: Session, agent: ReturnType<typeof wire>, dir: string, log: (l: string) => void): Promise<void> {
  const snap = session.snapshot();
  if (!snap.utterances.length) {
    log('nothing was said; no minutes to write');
    return;
  }

  const drafted = await writeMinutes(agent.fast, snap.utterances, snap.notebook);
  const title = drafted?.title || `Meeting ${snap.handle.room}`;
  const folder = await openFolder(dir, snap.startedAt.slice(0, 10), snap.handle.room, title);

  const record = buildRecord(snap, title, drafted?.minutes);

  await Bun.write(join(folder, 'minutes.md'), renderMarkdown(record));
  await writePdf(record, drafted?.markdown, join(folder, 'minutes.pdf'), log);

  for (const sink of agent.sinks) {
    const r = await sink.deliver(record).catch((e) => ({ ok: false, error: String(e) }));
    log(r.ok ? `delivered to ${sink.name}` : `sink ${sink.name} failed: ${r.error}`);
  }
  log(`minutes written to ${folder}`);
}

async function cmdJoin(configPath: string, target: string, quiet: boolean): Promise<number> {
  const log = quiet ? () => {} : (line: string) => console.error(`[${stamp()}] ${line}`);

  const file = await loadConfig(configPath);
  const agent = wire(file, log);
  const config = toSessionConfig(file);

  const room = parseGoogleMeetRoom(target) || target;
  log(`joining ${room} as ${file.name}`);
  const handle = await agent.transport.join(room, {
    displayName: file.name,
    language: file.language,
  });

  const session = new Session(handle, { ...agent, log }, config);
  await session.establishBaseline();
  log(`in the room, silent until someone says "${file.name}"`);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log('leaving');
    session.stop();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (await session.tick()) {
    await Bun.sleep(config.pollMs);
  }

  const dir = file.sinks?.find((s) => s.use === 'files')?.dir ?? './meetings';
  await finish(session, agent, dir, log);
  await agent.transport.leave(handle).catch(() => {});
  return 0;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(USAGE);
    return 2;
  }

  switch (args.command) {
    case 'init':
      return cmdInit(args.positional[0] ?? `./${NAME}.json`);
    case 'check':
      return cmdCheck(args.config, args.live);
    case 'join': {
      const target = args.positional[0];
      if (!target) {
        console.error(`${NAME} join needs a meeting room or link`);
        return 2;
      }
      return cmdJoin(args.config, target, args.quiet);
    }
    case 'version':
      console.log(`${NAME} 0.1.0`);
      return 0;
    default:
      console.log(USAGE);
      return args.command === 'help' ? 0 : 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof ConfigError) {
      console.error(`config: ${err.message}`);
      process.exit(2);
    }
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  });
