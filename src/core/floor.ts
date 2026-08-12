// Floor control: the decision of whether the agent may speak at all.
//
// This is the part that makes a meeting agent tolerable. Everything else in the
// system is plumbing — transcription, synthesis, transport. This file is the
// judgment. A bot that talks when it shouldn't is worse than no bot, and every
// gate below exists because a real meeting was disrupted without it.
//
// The model never decides whether to take the floor. It only decides what to say
// once the floor has already been granted by these rules. Keep it that way: a
// prompt is a suggestion, a gate is a guarantee.

export type DenyReason =
  | 'asleep'
  | 'not-addressed'
  | 'cooldown'
  | 'budget-exhausted'
  | 'already-thinking'
  | 'window-closed';

export interface FloorConfig {
  /** How long the floor stays open after the agent is addressed. */
  windowMs: number;
  /** Minimum gap between two turns, so the agent cannot monologue. */
  cooldownMs: number;
  /** Hard ceiling on turns per meeting. There is no override at runtime. */
  maxTurns: number;
  /** Wake phrase. Must be a token that does not occur in ordinary speech —
   *  see docs/wake-word.md for why this matters more than it sounds. */
  wake: RegExp;
  /** Phrases that mute the agent for the rest of the meeting. */
  sleep: RegExp;
  /** Phrases that close the current window without muting entirely. */
  hush: RegExp;
  /** After the agent speaks, a reply within this window counts as addressed
   *  even without the wake phrase — this is what makes it a conversation
   *  instead of a walkie-talkie. */
  followUpMs: number;
}

export const DEFAULT_FLOOR: Omit<FloorConfig, 'wake'> = {
  windowMs: 45_000,
  cooldownMs: 10_000,
  maxTurns: 20,
  followUpMs: 20_000,
  // "quiet", "stop", "that's enough", "thanks" — closes the window, stays awake.
  hush: /\b(quiet|hush|stop|enough|thanks|thank you)\b/i,
  // "go to sleep", "stand down", "leave" — mutes for the rest of the meeting.
  sleep: /\b(sleep|stand down|dismissed|shut down|leave us)\b/i,
};

export interface FloorState {
  /** Epoch ms until which the agent may respond. Zero means closed. */
  openUntil: number;
  /** Muted for the remainder of the meeting until explicitly woken. */
  asleep: boolean;
  /** Epoch ms of the last turn taken. */
  lastTurnAt: number;
  /** Turns taken so far, against maxTurns. */
  turns: number;
  /** Epoch ms while a turn is being produced. Zero when idle. */
  thinkingSince: number;
  /** Epoch ms while audio is playing, for barge-in. Zero when silent. */
  speakingSince: number;
}

export function newFloorState(): FloorState {
  return { openUntil: 0, asleep: false, lastTurnAt: 0, turns: 0, thinkingSince: 0, speakingSince: 0 };
}

export interface Utterance {
  text: string;
  speaker: string;
  /** Epoch ms when this utterance was considered final. */
  at: number;
}

export type FloorDecision =
  | { grant: true; reason: 'wake' | 'follow-up'; state: FloorState }
  | { grant: false; reason: DenyReason };

/** Does this utterance address the agent directly?
 *
 *  Two ways in. The wake phrase is the explicit one. The other is a reply that
 *  lands shortly after the agent itself spoke — people do not repeat a name
 *  every sentence, and requiring them to turns dialogue into radio protocol.
 *  The follow-up path is deliberately short and dies the moment the window does. */
export function addresses(u: Utterance, s: FloorState, c: FloorConfig): 'wake' | 'follow-up' | null {
  if (c.wake.test(u.text)) return 'wake';
  if (s.lastTurnAt && u.at - s.lastTurnAt <= c.followUpMs && u.at < s.openUntil) return 'follow-up';
  return null;
}

/** The single entry point for "may I speak?". Callers must not second-guess a
 *  denial: every branch here is a lesson from a meeting that went wrong. */
export function requestFloor(u: Utterance, s: FloorState, c: FloorConfig): FloorDecision {
  if (s.thinkingSince) return { grant: false, reason: 'already-thinking' };

  const how = addresses(u, s, c);
  if (!how) return { grant: false, reason: 'not-addressed' };

  // Waking is allowed even while asleep — otherwise there is no way back in
  // except restarting the agent, which nobody does mid-meeting.
  if (s.asleep && how !== 'wake') return { grant: false, reason: 'asleep' };

  if (s.turns >= c.maxTurns) return { grant: false, reason: 'budget-exhausted' };
  if (s.lastTurnAt && u.at - s.lastTurnAt < c.cooldownMs) return { grant: false, reason: 'cooldown' };

  return {
    grant: true,
    reason: how,
    state: { ...s, asleep: false, openUntil: u.at + c.windowMs, thinkingSince: u.at },
  };
}

/** Voice commands that change the agent's posture rather than ask it anything.
 *  Checked before the floor, because "stop" must work while it is mid-sentence. */
export function applyVoiceCommand(u: Utterance, s: FloorState, c: FloorConfig): FloorState | null {
  if (!c.wake.test(u.text) && !s.openUntil) return null;

  if (c.sleep.test(u.text)) return { ...s, asleep: true, openUntil: 0, thinkingSince: 0 };
  if (c.hush.test(u.text)) return { ...s, openUntil: 0, thinkingSince: 0 };
  return null;
}

/** Records a turn and re-opens the window from now, so the person who just got
 *  an answer has room to reply without saying the wake phrase again. */
export function turnTaken(s: FloorState, at: number, c: FloorConfig): FloorState {
  return {
    ...s,
    turns: s.turns + 1,
    lastTurnAt: at,
    thinkingSince: 0,
    speakingSince: at,
    openUntil: at + c.windowMs,
  };
}

/** Playback is over; barge-in no longer applies. Estimated from text length
 *  because the transport reports no playback-finished event: roughly 15
 *  characters per second of speech, with a small tail for latency. */
export function speechDurationMs(text: string): number {
  return Math.min(30_000, (text.length / 15) * 1000 + 1500);
}

/** Someone talked over the agent: it yields immediately. Interrupting a machine
 *  should feel like interrupting a polite person, not fighting a recording. */
export function shouldYield(u: Utterance, s: FloorState): boolean {
  return Boolean(s.speakingSince) && u.at > s.speakingSince;
}
