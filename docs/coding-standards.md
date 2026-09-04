# Coding standards

## Fail loudly

No silent defaults, placeholder success, or swallowed rejections; a loud
failure beats a silent wrong answer. Undesigned code fails with
`NotImplementedError` from `@know-the-map/harness`. No blanket fallbacks
(`Effect.catch`, broad `try/catch`) "just in case" — handle exactly the
tagged errors a channel declares; let the unexpected crash.

## Preconditions

When types or Schema can't guarantee a precondition, assert it at the
function boundary: functions defend assumptions instead of trusting callers —
loose coupling, local failures. How the check is written depends on what it
tests:

- A precondition on an effect's own value → `Effect.filterOrFail`: it narrows
  the success type and builds the error lazily, only on failure.
- A precondition without a value under test → `guard(cond, () => new E())`
  from `@know-the-map/harness`. Never an eager `assert(cond, err)`: the error
  (and its captured stack) would be built even when the condition holds.
- A failure path that itself performs effects (log, inspect, then fail) →
  a plain `if` on a bound result; combinators only make it worse.
- Never defect-style assertions (`Console.assert`): expected failures stay
  typed in the error channel.

Raise with `return yield* new E(...)` so TypeScript knows execution stops.

## Gates

`bun run check` · `bun run typecheck` · `bun test packages apps` — all must pass.

## TypeScript

`verbatimModuleSyntax`; `.ts` extensions in relative imports; guards over `!`.
Comments only for nuance or complexity — the why, not the what.

Bind before branching: `const a = yield* f(); if (a)` — never
`if (yield* f())` or `if (await f())`. Constants live where they are used;
`as const` for literal invariants. Every hardcoded tunable carries
`// TODO(config)` until configuration exists.

## Schemas

Strict types: literals/unions over bare strings/numbers, narrow checks
(`PositiveInt`) over accepting anything. Every field documents itself via
`.annotate({ description })`, not TS comments — descriptions flow into error
messages and generated JSON schemas.

Every boundary payload — command output, tool input, wire data — gets a named
type or Schema; over-typing beats implicit coupling. Invariants belong in the
Schema (discriminated unions, pattern checks), not in post-decode validation
functions. Named declarations only: no inline or partial interfaces that
shadow the full shape.

## Effect

`Effect.gen`/`Effect.fn`, combinators in `.pipe` (per the Effect skill — load
it before writing Effect code). Services: `Context.Service` + static `Layer`;
errors: `Schema.TaggedError`. Keep errors typed — no `Exit`/`flip` gymnastics.
No single-use one-line helpers: inline trivial predicates ("death by
functionitis").

## Errors

One error construction per failure. When only message or cause differs
between two branches, put the ternary inside the constructor's fields — the
smallest branch possible — never around the whole error.

## Logging

Logs are product surface: phrase them for the developer using the tool, not
the one building it. Internal jargon and debug shorthand don't belong in
info/warn lines.

## Prompts

Prompts are product copy. No brand or system names inside them; the model
has no use for them. Set an explicit verbosity level instead of leaving it
to the model. State ignore-lists concretely (`.ktm/`, `dist/`, generated
output).

## Monorepo

`catalog:` shared versions, `workspace:*` internal, `@know-the-map/*` scope;
`packages/*` libs, `apps/*` executables. `harness-probe/` reference-only:
transplant, never import.
