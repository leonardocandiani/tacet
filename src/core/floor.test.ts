import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_FLOOR,
  addresses,
  applyVoiceCommand,
  newFloorState,
  requestFloor,
  shouldYield,
  speechDurationMs,
  turnTaken,
  type FloorConfig,
  type FloorState,
} from './floor';

const CONFIG: FloorConfig = { ...DEFAULT_FLOOR, wake: /\bnova\b/i };

const said = (text: string, at: number, speaker = 'Alex') => ({ text, speaker, at });

describe('floor control', () => {
  test('stays silent when nobody addressed it', () => {
    const d = requestFloor(said('so the deploy went out friday', 1000), newFloorState(), CONFIG);
    expect(d.grant).toBe(false);
    expect(d).toMatchObject({ reason: 'not-addressed' });
  });

  test('grants the floor on the wake phrase', () => {
    const d = requestFloor(said('nova, what did we decide?', 1000), newFloorState(), CONFIG);
    expect(d.grant).toBe(true);
    expect(d).toMatchObject({ reason: 'wake' });
  });

  test('a reply right after its own turn counts as addressed', () => {
    const spoke: FloorState = { ...newFloorState(), lastTurnAt: 10_000, openUntil: 50_000 };
    expect(addresses(said('and what about the second one?', 12_000), spoke, CONFIG)).toBe('follow-up');
  });

  test('the same reply much later does not', () => {
    const spoke: FloorState = { ...newFloorState(), lastTurnAt: 10_000, openUntil: 50_000 };
    expect(addresses(said('and what about the second one?', 45_000), spoke, CONFIG)).toBeNull();
  });

  test('follow-up dies with the window even if recent', () => {
    const spoke: FloorState = { ...newFloorState(), lastTurnAt: 10_000, openUntil: 11_000 };
    expect(addresses(said('and the other thing', 12_000), spoke, CONFIG)).toBeNull();
  });

  test('cooldown blocks a second turn too soon', () => {
    const justSpoke: FloorState = { ...newFloorState(), lastTurnAt: 10_000, openUntil: 50_000 };
    const d = requestFloor(said('nova, one more thing', 12_000), justSpoke, CONFIG);
    expect(d).toMatchObject({ grant: false, reason: 'cooldown' });
  });

  test('turn budget is a hard ceiling', () => {
    const spent: FloorState = { ...newFloorState(), turns: CONFIG.maxTurns };
    const d = requestFloor(said('nova, are you there', 99_000), spent, CONFIG);
    expect(d).toMatchObject({ grant: false, reason: 'budget-exhausted' });
  });

  test('one turn at a time — no overlapping thinking', () => {
    const busy: FloorState = { ...newFloorState(), thinkingSince: 5_000 };
    const d = requestFloor(said('nova, hello', 6_000), busy, CONFIG);
    expect(d).toMatchObject({ grant: false, reason: 'already-thinking' });
  });

  test('asleep ignores follow-ups but still answers its name', () => {
    const asleep: FloorState = { ...newFloorState(), asleep: true, lastTurnAt: 1_000, openUntil: 60_000 };
    expect(requestFloor(said('what about that', 2_000), asleep, CONFIG)).toMatchObject({ grant: false });

    const woken = requestFloor(said('nova, come back', 30_000), asleep, CONFIG);
    expect(woken.grant).toBe(true);
    if (woken.grant) expect(woken.state.asleep).toBe(false);
  });

  test('"nova, quiet" closes the window without muting the meeting', () => {
    const open: FloorState = { ...newFloorState(), openUntil: 60_000 };
    const after = applyVoiceCommand(said('nova, quiet please', 10_000), open, CONFIG);
    expect(after).toMatchObject({ openUntil: 0, asleep: false });
  });

  test('"nova, go to sleep" mutes it', () => {
    const open: FloorState = { ...newFloorState(), openUntil: 60_000 };
    const after = applyVoiceCommand(said('nova, go to sleep', 10_000), open, CONFIG);
    expect(after).toMatchObject({ asleep: true, openUntil: 0 });
  });

  test('a stop word in ordinary conversation is ignored while closed', () => {
    // "thanks" is a hush word, but nobody was talking to the agent.
    expect(applyVoiceCommand(said('thanks for sending that over', 10_000), newFloorState(), CONFIG)).toBeNull();
  });

  test('taking a turn re-opens the window from now', () => {
    const s = turnTaken(newFloorState(), 10_000, CONFIG);
    expect(s.turns).toBe(1);
    expect(s.openUntil).toBe(10_000 + CONFIG.windowMs);
    expect(s.thinkingSince).toBe(0);
  });

  test('yields the moment someone talks over it', () => {
    const speaking: FloorState = { ...newFloorState(), speakingSince: 10_000 };
    expect(shouldYield(said('actually wait', 10_500), speaking)).toBe(true);
    expect(shouldYield(said('actually wait', 10_500), newFloorState())).toBe(false);
  });

  test('speech duration scales with length and stays bounded', () => {
    expect(speechDurationMs('yes')).toBeLessThan(speechDurationMs('yes, and here is the longer answer'));
    expect(speechDurationMs('x'.repeat(100_000))).toBeLessThanOrEqual(30_000);
  });
});

describe('a stale window does not accept bare commands', () => {
  const c = { ...DEFAULT_FLOOR, wake: /\bnova\b/i };

  test('an hour after the window closed, "sleep" in ordinary speech is ignored', () => {
    const spoke = turnTaken(newFloorState(), 1_000_000, c);
    const muchLater = 1_000_000 + c.windowMs + 3_600_000;
    expect(applyVoiceCommand({ text: 'sorry, I barely got any sleep last night', speaker: 'Bo', at: muchLater }, spoke, c)).toBeNull();
  });

  test('the same words inside the open window do mute it', () => {
    const spoke = turnTaken(newFloorState(), 1_000_000, c);
    const inside = 1_000_000 + 5_000;
    expect(applyVoiceCommand({ text: 'go to sleep', speaker: 'Bo', at: inside }, spoke, c)?.asleep).toBe(true);
  });

  test('the wake word works whether or not the window is open', () => {
    const cold = newFloorState();
    expect(applyVoiceCommand({ text: 'nova, go to sleep', speaker: 'Bo', at: 5_000_000 }, cold, c)?.asleep).toBe(true);
  });
});
