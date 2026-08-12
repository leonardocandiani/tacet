# Contributing

## Before a pull request

```bash
bun run check     # typecheck, lint, tests
```

All three have to pass. The lint rules are budgets, not suggestions: a function
past a complexity of 10 is one nobody will safely change later. If a limit is in
your way, the answer is a simpler function, never a raised limit.

## What a good change looks like

**The decision logic is a specification.** `src/core/floor.ts` and
`src/core/notebook.ts` are pure functions with no I/O, and their tests describe
the behaviour this project promises. If you change when the agent speaks, change
the tests first and let them state the new promise.

**A new provider is an adapter, not a branch in the core.** See
[docs/adapters.md](docs/adapters.md). If your change needs `src/core` to know
which provider is configured, the seam is in the wrong place.

**Comments explain why, not what.** Nearly every comment in this codebase records
something that went wrong in a real meeting. That is the bar: if the reason is
obvious from the code, leave it out.

## Reporting a bug

Meeting bugs are hard to reproduce and easy to describe badly. What helps:

- The transcript excerpt, with names removed.
- What the agent did, and what it should have done instead.
- Your `tacet check` output. It never prints key values, only their variable names.

"It spoke when it should not have" is the most valuable report you can file, and
it should quote the utterance that triggered it verbatim. That sentence becomes
the test case.

## Scope

Read [docs/decisions.md](docs/decisions.md) before proposing a feature. Several
obvious ones were considered and rejected with reasons written down. A pull
request is a fine place to argue against those reasons — but the argument has to
happen, because the defaults there protect people who are in a meeting and cannot
opt out of what the agent decides to do.
