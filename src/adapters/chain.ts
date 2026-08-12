// Fallback chains.
//
// Every external provider in this system fails sometimes, and a meeting does not
// pause while you retry. So each seam takes a list of providers instead of one,
// and the chain walks it. This is the single most load-bearing piece of
// reliability in the project, and it is thirty lines.
//
// One design note worth keeping: a provider that answers with something useless
// counts as a failure. A transcriber returning empty text and a model returning
// half a document are both "next provider, please" — HTTP 200 is not success.

export interface ChainOptions<T> {
  /** Called with each provider's name when it fails, for the log. */
  onFail?: (name: string, error: string) => void;
  /** Rejects a technically-successful result that is not good enough to use.
   *  Return false and the chain moves on. */
  accept?: (value: T) => boolean;
  /** Attempts per provider before moving on. One is often right: with a meeting
   *  running, a slow retry costs more than a fast fallback. */
  attempts?: number;
}

export interface Attempt<T> {
  name: string;
  run: () => Promise<T>;
}

export class AllProvidersFailed extends Error {
  constructor(public readonly failures: Array<{ name: string; error: string }>) {
    super(`every provider failed: ${failures.map((f) => `${f.name} (${f.error})`).join(', ')}`);
    this.name = 'AllProvidersFailed';
  }
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string; fatal: boolean };

/** One run of one provider. `fatal` means "stop retrying this provider": a
 *  result the caller rejected will be rejected again, so retrying wastes a
 *  provider's worth of time while a meeting waits. */
async function runOnce<T>(attempt: Attempt<T>, accept?: (v: T) => boolean): Promise<Outcome<T>> {
  try {
    const value = await attempt.run();
    if (accept && !accept(value)) return { ok: false, error: 'result rejected by caller', fatal: true };
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), fatal: false };
  }
}

/** Walks the chain and returns the first acceptable result.
 *
 *  Throws AllProvidersFailed with every error collected, rather than only the
 *  last one — debugging a chain from a single error message is guesswork. */
export async function firstSuccess<T>(
  attempts: Array<Attempt<T>>,
  opts: ChainOptions<T> = {},
): Promise<{ value: T; provider: string }> {
  const failures: Array<{ name: string; error: string }> = [];
  const tries = Math.max(1, opts.attempts ?? 1);

  for (const attempt of attempts) {
    for (let i = 0; i < tries; i++) {
      const outcome = await runOnce(attempt, opts.accept);
      if (outcome.ok) return { value: outcome.value, provider: attempt.name };
      failures.push({ name: attempt.name, error: outcome.error });
      opts.onFail?.(attempt.name, outcome.error);
      if (outcome.fatal) break;
    }
  }

  throw new AllProvidersFailed(failures);
}

/** Like firstSuccess but returns null instead of throwing. For paths where
 *  losing the result is survivable — the agent staying quiet, say — and taking
 *  the whole meeting down with it is not. */
export async function firstSuccessOrNull<T>(attempts: Array<Attempt<T>>, opts: ChainOptions<T> = {}): Promise<T | null> {
  try {
    return (await firstSuccess(attempts, opts)).value;
  } catch {
    return null;
  }
}

/** Wraps a promise with a deadline. Providers that hang are the common failure,
 *  not providers that error: without this the chain never reaches the fallback. */
export function withDeadline<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
