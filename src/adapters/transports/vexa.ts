// Transport backed by a self-hosted Vexa deployment.
//
// Vexa (Apache-2.0) runs the hard part: a container with a real browser that
// joins the call as a participant, captures audio and reports who is speaking.
// This adapter is the thin layer between its REST API and our contracts.
//
// Two things here look odd and are deliberate. Transcripts are fetched by
// numeric meeting id, never by room code — see `transcript` below. And speech is
// published on Redis rather than over HTTP, because that is the channel the bot
// container actually listens on.

import type { JoinOptions, MeetingHandle, MeetingStatus, SpokenAudio, Transport, Utterance } from '../contracts';

export interface VexaOptions {
  /** Gateway base URL, e.g. http://localhost:18056 */
  baseUrl: string;
  apiKey: string;
  /** How the `speak` command reaches the bot. Vexa's own API exposes a speak
   *  route; older deployments only listen on the Redis channel. */
  speech?: SpeechChannel;
  timeoutMs?: number;
}

export type SpeechChannel =
  | { via: 'api' }
  | {
      via: 'redis';
      /** Container name to exec into, for deployments where Redis is not
       *  reachable from this process. */
      container: string;
      /** Redis CLI inside that container. Valkey ships `valkey-cli`. */
      cli?: string;
      docker?: string;
    };

interface VexaTranscript {
  id?: number;
  status?: string;
  segments?: Array<{ start?: number; text?: string; speaker?: string }>;
}

/** Vexa's lifecycle words, mapped onto ours. Anything unrecognised is treated
 *  as live: guessing "ended" would abandon a running meeting. */
const STATUS: Record<string, MeetingStatus> = {
  requested: 'joining',
  joining: 'joining',
  awaiting_admission: 'waiting',
  active: 'live',
  completed: 'ended',
  stopped: 'ended',
  failed: 'failed',
  error: 'failed',
};

export function vexaTransport(opts: VexaOptions): Transport {
  const timeout = opts.timeoutMs ?? 15_000;
  const speech: SpeechChannel = opts.speech ?? { via: 'api' };

  const call = async (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${opts.baseUrl}${path}`, {
      ...init,
      headers: { 'X-API-Key': opts.apiKey, 'Content-Type': 'application/json', ...init.headers },
      signal: AbortSignal.timeout(timeout),
    });

  const readMeeting = async (handle: MeetingHandle): Promise<VexaTranscript | null> => {
    // By id, never by room code. `/transcripts/{platform}/{room}` returns the
    // MOST RECENT session for that code, and a bot joins the same room several
    // times a day. A meeting once closed with zero lines because the newest
    // session had died in the waiting room while the real one, with the whole
    // conversation, was the session before it.
    const r = await call(`/transcripts/by-id/${handle.id}`);
    if (!r.ok) return null;
    return (await r.json()) as VexaTranscript;
  };

  return {
    name: 'vexa',

    async join(room: string, o: JoinOptions): Promise<MeetingHandle> {
      const r = await call('/bots', {
        method: 'POST',
        body: JSON.stringify({
          platform: 'google_meet',
          native_meeting_id: room,
          bot_name: o.displayName,
          language: o.language,
          task: 'transcribe',
          automatic_leave: {
            // An hour, not the ten-minute default. Participants who mute
            // disappear from the platform's own "is anyone here" signal, and the
            // bot concludes the room emptied while people are still talking.
            max_time_left_alone: o.leaveWhenAloneMs ?? 3_600_000,
          },
        }),
      });

      const body = (await r.json().catch(() => ({}))) as { id?: number; detail?: string };
      if (!r.ok || !body.id) throw new Error(`join failed (${r.status}): ${body.detail ?? 'no detail'}`);
      return { id: String(body.id), room, platform: 'google_meet' };
    },

    async leave(handle: MeetingHandle): Promise<void> {
      await call(`/bots/${handle.platform}/${handle.room}`, { method: 'DELETE' }).catch(() => {});
    },

    async status(handle: MeetingHandle): Promise<MeetingStatus> {
      const meeting = await readMeeting(handle);
      if (!meeting) return 'live'; // a failed read is not proof of an ended meeting
      return STATUS[String(meeting.status ?? '')] ?? 'live';
    },

    async transcript(handle: MeetingHandle): Promise<Utterance[]> {
      const meeting = await readMeeting(handle);
      if (!meeting) return [];
      return (meeting.segments ?? [])
        .map((s) => ({
          offset: Number(s.start ?? 0),
          text: String(s.text ?? '').trim(),
          speaker: s.speaker ? String(s.speaker) : undefined,
        }))
        .filter((u) => u.text.length > 0);
    },

    async speak(handle: MeetingHandle, audio: SpokenAudio): Promise<void> {
      await publish(handle, { action: 'speak', audio: encodePcm(audio) }, speech, call);
    },

    async stopSpeaking(handle: MeetingHandle): Promise<void> {
      await publish(handle, { action: 'speak_stop' }, speech, call);
    },

    async postToChat(handle: MeetingHandle, text: string): Promise<void> {
      await call(`/bots/${handle.platform}/${handle.room}/chat`, {
        method: 'POST',
        body: JSON.stringify({ message: text }),
      }).catch(() => {});
    },
  };
}

function encodePcm(audio: SpokenAudio): { pcm_base64: string; sample_rate: number } {
  return { pcm_base64: Buffer.from(audio.pcm).toString('base64'), sample_rate: audio.sampleRate };
}

type Caller = (path: string, init?: RequestInit) => Promise<Response>;

/** Sends a command to the bot container.
 *
 *  The Redis path shells out through `docker exec` and passes the payload on
 *  stdin rather than as an argument. That is not squeamishness: an argument goes
 *  through the shell's encoding, and accented text arrives mangled — which in
 *  practice means the agent speaks a sentence with the accents stripped out. */
async function publish(
  handle: MeetingHandle,
  command: Record<string, unknown>,
  speech: SpeechChannel,
  call: Caller,
): Promise<void> {
  if (speech.via === 'api') {
    const r = await call(`/bots/${handle.platform}/${handle.room}/speak`, {
      method: 'POST',
      body: JSON.stringify(command),
    });
    if (!r.ok) throw new Error(`speak failed: http ${r.status}`);
    return;
  }

  const proc = Bun.spawn(
    [
      speech.docker ?? 'docker',
      'exec',
      '-i',
      speech.container,
      speech.cli ?? 'valkey-cli',
      '-x',
      'PUBLISH',
      `bot_commands:meeting:${handle.id}`,
    ],
    { stdin: new TextEncoder().encode(JSON.stringify(command)), stdout: 'pipe', stderr: 'pipe' },
  );

  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`publish failed: ${(await new Response(proc.stderr).text()).slice(0, 200)}`);
  }
}

/** Accepts a full meeting link or a bare room code, because people paste links. */
export function parseGoogleMeetRoom(input: string): string {
  const trimmed = input
    .trim()
    .replace(/^(https?:\/\/)?(www\.)?meet\.google\.com\//i, '')
    .split(/[?#/]/)[0];
  return /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(trimmed ?? '') ? (trimmed ?? '').toLowerCase() : '';
}
