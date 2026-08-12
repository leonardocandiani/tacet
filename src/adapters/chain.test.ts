import { describe, expect, test } from 'bun:test';
import { AllProvidersFailed, firstSuccess, firstSuccessOrNull, withDeadline } from './chain';

const ok = (name: string, value: string) => ({ name, run: async () => value });
const boom = (name: string, why = 'exploded') => ({
  name,
  run: async () => {
    throw new Error(why);
  },
});

describe('fallback chain', () => {
  test('takes the first provider that works', async () => {
    const r = await firstSuccess([ok('primary', 'a'), ok('backup', 'b')]);
    expect(r).toMatchObject({ value: 'a', provider: 'primary' });
  });

  test('falls through to the backup', async () => {
    const r = await firstSuccess([boom('primary'), ok('backup', 'b')]);
    expect(r).toMatchObject({ value: 'b', provider: 'backup' });
  });

  test('a technically-successful but useless result is a failure', async () => {
    const r = await firstSuccess([ok('primary', ''), ok('backup', 'real answer')], {
      accept: (v) => v.length > 0,
    });
    expect(r.provider).toBe('backup');
  });

  test('a rejected result does not burn the remaining attempts of that provider', async () => {
    let calls = 0;
    const flaky = {
      name: 'flaky',
      run: async () => {
        calls += 1;
        return '';
      },
    };
    await firstSuccessOrNull([flaky, ok('backup', 'x')], { accept: (v) => v.length > 0, attempts: 3 });
    expect(calls).toBe(1);
  });

  test('retries within a provider before moving on', async () => {
    let calls = 0;
    const secondTime = {
      name: 'flaky',
      run: async () => {
        calls += 1;
        if (calls < 2) throw new Error('transient');
        return 'recovered';
      },
    };
    const r = await firstSuccess([secondTime, ok('backup', 'b')], { attempts: 2 });
    expect(r).toMatchObject({ value: 'recovered', provider: 'flaky' });
  });

  test('reports every failure, not just the last', async () => {
    const err = await firstSuccess([boom('a', 'no key'), boom('b', 'rate limited')]).catch((e) => e);
    expect(err).toBeInstanceOf(AllProvidersFailed);
    expect(err.failures).toHaveLength(2);
    expect(err.message).toContain('no key');
    expect(err.message).toContain('rate limited');
  });

  test('calls back on each failure so the log names the culprit', async () => {
    const seen: string[] = [];
    await firstSuccessOrNull([boom('a'), ok('b', 'x')], { onFail: (n) => seen.push(n) });
    expect(seen).toEqual(['a']);
  });

  test('the nullable form swallows total failure', async () => {
    expect(await firstSuccessOrNull([boom('a'), boom('b')])).toBeNull();
  });

  test('a hanging provider is cut off by the deadline', async () => {
    const hang = new Promise<string>(() => {});
    await expect(withDeadline(hang, 20, 'stt')).rejects.toThrow('stt exceeded 20ms');
  });

  test('the deadline does not interfere with a fast answer', async () => {
    expect(await withDeadline(Promise.resolve('quick'), 1_000)).toBe('quick');
  });
});
