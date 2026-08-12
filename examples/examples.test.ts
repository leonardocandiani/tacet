import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseConfig, toSessionConfig } from '../src/config';

// Documentation rots silently. These run in CI so an example that stops parsing
// fails the build instead of failing a stranger on their first evening with the
// project.

const HERE = new URL('.', import.meta.url).pathname;

async function examples(): Promise<string[]> {
  return (await readdir(HERE)).filter((f) => f.endsWith('.json')).sort();
}

describe('shipped examples', () => {
  test('there are examples to check', async () => {
    expect((await examples()).length).toBeGreaterThan(0);
  });

  test('every example parses and builds a usable session config', async () => {
    for (const name of await examples()) {
      const text = await Bun.file(join(HERE, name)).text();
      const file = parseConfig(text);
      const session = toSessionConfig(file);

      expect(file.name, `${name}: needs a name`).toBeTruthy();
      expect(session.floor.wake.test(file.name), `${name}: the name must match its own wake pattern`).toBe(true);
      expect(session.pollMs, `${name}: poll interval`).toBeGreaterThan(0);
    }
  });

  test('no example contains anything that looks like a real key', async () => {
    const smells = [/sk-[A-Za-z0-9]{16,}/, /AIza[0-9A-Za-z_-]{20,}/, /ghp_[A-Za-z0-9]{20,}/, /Bearer\s+[A-Za-z0-9._-]{20,}/];
    for (const name of await examples()) {
      const text = await Bun.file(join(HERE, name)).text();
      for (const smell of smells) {
        expect(smell.test(text), `${name} looks like it contains a credential`).toBe(false);
      }
    }
  });

  test('the listen-only example really cannot speak', async () => {
    const file = parseConfig(await Bun.file(join(HERE, 'listen-only.json')).text());
    expect(toSessionConfig(file).floor.maxTurns).toBe(0);
    expect(file.voice ?? []).toHaveLength(0);
  });
});
