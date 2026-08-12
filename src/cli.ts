#!/usr/bin/env bun
// The command line. Four verbs and no flags worth memorising.

import { EXAMPLE_CONFIG, loadConfig, toSessionConfig, ConfigError } from './config';
import { Session } from './core/session';
import { wire } from './wire';
import { parseGoogleMeetRoom } from './adapters/transports/vexa';
import { writeMinutes, type DraftedMinutes } from './core/minutes';
import { renderPdf } from './render/pdf';
import { renderMarkdown, slug } from './adapters/sinks';
import type { MeetingRecord } from './adapters/contracts';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

const NAME = 'tacet';

const USAGE = `${NAME} — silent by default

  ${NAME} init [path]           write an example config next to you
  ${NAME} join <room|url>       join a meeting and stay until it ends
  ${NAME} check                 verify the config and every provider it names
  ${NAME} version

Options
  --config <path>   default: ./${NAME}.json
  --quiet           only errors
`;

interface Args {
  command: string;
  positional: string[];
  config: string;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let config = `./${NAME}.json`;
  let quiet = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') config = argv[++i] ?? config;
    else if (a === '--quiet') quiet = true;
    else if (a?.startsWith('-')) throw new Error(`unknown option ${a}`);
    else if (a) positional.push(a);
  }

  return { command: positional.shift() ?? 'help', positional, config, quiet };
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

async function cmdCheck(configPath: string): Promise<number> {
  const file = await loadConfig(configPath);
  const agent = wire(file);
  const session = toSessionConfig(file);

  console.log(`config      ${configPath}`);
  console.log(`agent       ${file.name}`);
  console.log(`wakes on    ${session.floor.wake}`);
  console.log(`transport   ${agent.transport.name}`);
  console.log(`fast        ${agent.fast.name}`);
  console.log(`deep        ${agent.deep?.name ?? '(none — it will never look anything up)'}`);
  console.log(`voice       ${agent.voice?.name ?? '(none — it will use the meeting chat)'}`);
  console.log(`sinks       ${agent.sinks.map((s) => s.name).join(', ') || '(none — nothing will be saved)'}`);
  console.log(`floor       window ${session.floor.windowMs / 1000}s · cooldown ${session.floor.cooldownMs / 1000}s · max ${session.floor.maxTurns} turns`);

  // A wake word that matches ordinary speech is the single most damaging
  // misconfiguration: the agent interrupts a meeting it was never called into.
  const ordinary = ['the', 'and', 'yes', 'no', 'ok', 'so', 'well', 'right', 'sure', 'now', 'hey'];
  const clash = ordinary.find((w) => session.floor.wake.test(w));
  if (clash) {
    console.error(`\n!  the wake word matches the ordinary word "${clash}" — it will speak uninvited`);
    return 1;
  }

  console.log('\nlooks usable.');
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

async function finish(session: Session, agent: ReturnType<typeof wire>, dir: string, log: (l: string) => void): Promise<void> {
  const snap = session.snapshot();
  if (!snap.utterances.length) {
    log('nothing was said; no minutes to write');
    return;
  }

  const drafted = await writeMinutes(agent.fast, snap.utterances, snap.notebook);
  const title = drafted?.title || `Meeting ${snap.handle.room}`;
  const folder = join(dir, `${snap.startedAt.slice(0, 10)}_${slug(title) || snap.handle.room}`);
  await mkdir(folder, { recursive: true });

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
      return cmdCheck(args.config);
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
