import { describe, expect, test } from 'bun:test';
import { ConfigError, EXAMPLE_CONFIG, parseConfig, toSessionConfig, wakePattern } from './config';

const MINIMAL = JSON.stringify({
  name: 'Nova',
  transport: { use: 'vexa', baseUrl: 'http://localhost:18056' },
  fast: [{ use: 'gemini', keyEnv: 'GEMINI_API_KEY' }],
});

describe('wake patterns', () => {
  test('matches the name as a whole word', () => {
    const re = wakePattern('Nova');
    expect(re.test('nova, are you there')).toBe(true);
    expect(re.test('NOVA?')).toBe(true);
  });

  test('does not fire inside a longer word', () => {
    expect(wakePattern('Nova').test('this is a real innovation')).toBe(false);
  });

  test('accepts the misspellings the recogniser actually produces', () => {
    const re = wakePattern('Nova', ['novah', 'nowa']);
    expect(re.test('hey novah can you check')).toBe(true);
    expect(re.test('nowa, what did we decide')).toBe(true);
  });

  test('a name with regex characters is escaped, not compiled', () => {
    const re = wakePattern('C++');
    expect(() => re.test('anything')).not.toThrow();
  });

  test('an empty name is refused rather than matching everything', () => {
    expect(() => wakePattern('   ')).toThrow(ConfigError);
  });
});

describe('parsing', () => {
  test('reads a minimal config', () => {
    expect(parseConfig(MINIMAL).name).toBe('Nova');
  });

  test('the shipped example is valid', () => {
    expect(parseConfig(EXAMPLE_CONFIG).name).toBe('Nova');
  });

  test('comments are allowed, because a config meant to be read gets annotated', () => {
    const withComments = `{\n  // who we are\n  "name": "Nova",\n  "transport": { "use": "vexa" },\n  "fast": [{ "use": "gemini", "keyEnv": "K" }]\n}`;
    expect(parseConfig(withComments).name).toBe('Nova');
  });

  test('broken JSON says so', () => {
    expect(() => parseConfig('{ nope')).toThrow(ConfigError);
  });

  test('a missing name is caught before anything starts', () => {
    expect(() => parseConfig(JSON.stringify({ transport: { use: 'vexa' }, fast: [{ use: 'x' }] }))).toThrow(/name/);
  });

  test('no fast provider is caught, with an example in the message', () => {
    const bad = JSON.stringify({ name: 'Nova', transport: { use: 'vexa' }, fast: [] });
    expect(() => parseConfig(bad)).toThrow(/fast/);
  });
});

describe('session config', () => {
  test('seconds in the file become milliseconds in the runtime', () => {
    const file = parseConfig(MINIMAL);
    const cfg = toSessionConfig({ ...file, floor: { windowSeconds: 30, cooldownSeconds: 5, maxTurns: 3 } });
    expect(cfg.floor.windowMs).toBe(30_000);
    expect(cfg.floor.cooldownMs).toBe(5_000);
    expect(cfg.floor.maxTurns).toBe(3);
  });

  test('omitted values fall back to the defaults', () => {
    const cfg = toSessionConfig(parseConfig(MINIMAL));
    expect(cfg.floor.windowMs).toBeGreaterThan(0);
    expect(cfg.pollMs).toBeGreaterThan(0);
    expect(cfg.persona.length).toBeGreaterThan(0);
  });

  test('a zero or negative duration is ignored rather than disabling the gate', () => {
    const cfg = toSessionConfig({ ...parseConfig(MINIMAL), floor: { cooldownSeconds: 0 } });
    expect(cfg.floor.cooldownMs).toBeGreaterThan(0);
  });

  test('the wake pattern is built from the name and its aliases', () => {
    const cfg = toSessionConfig({ ...parseConfig(MINIMAL), wakeAliases: ['novah'] });
    expect(cfg.floor.wake.test('novah are you there')).toBe(true);
  });
});

describe('the compiled wake pattern', () => {
  test('matches the name it was built from, accents and all', () => {
    for (const name of ['Nova', 'Ná', 'Zophie', 'Kestrel']) {
      expect(wakePattern(name).test(`hey ${name}, are you there?`)).toBe(true);
    }
  });

  test('does not fire inside a longer word', () => {
    expect(wakePattern('Nova').test('the supernova was bright')).toBe(false);
    expect(wakePattern('Nova').test('novabank called')).toBe(false);
  });

  test('a name with punctuation in it still matches itself', () => {
    // The escaping used to be able to produce a pattern that could not match the
    // very name it was built from, and the failure was silent: the agent simply
    // never woke up. Building one now proves it matches before returning.
    expect(wakePattern('N.O.V.A').test('so N.O.V.A, where are we?')).toBe(true);
    expect(wakePattern('C-3PO').test('C-3PO, take a note')).toBe(true);
  });

  test('an empty name is refused rather than compiled into a pattern', () => {
    expect(() => wakePattern('   ')).toThrow();
  });

  test('aliases are alternatives, not replacements', () => {
    const p = wakePattern('Nova', ['novah', 'nowa']);
    expect(p.test('novah, what did we decide')).toBe(true);
    expect(p.test('nova, what did we decide')).toBe(true);
  });
});

describe('reading a config file', () => {
  test('a comment at the end of a line does not break the parse', () => {
    const file = parseConfig(`{
  "name": "Nova",                        // also the wake word
  "transport": { "use": "vexa", "baseUrl": "http://localhost:18056" },  // not a comment: the //
  "fast": [{ "use": "gemini" }]
}`);
    expect(file.name).toBe('Nova');
    expect(file.transport.baseUrl).toBe('http://localhost:18056');
  });

  test('a negative turn budget is refused with a usable hint', () => {
    expect(() =>
      parseConfig('{"name":"Nova","transport":{"use":"vexa"},"fast":[{"use":"gemini"}],"floor":{"maxTurns":-1}}'),
    ).toThrow(/maxTurns/);
  });
});
