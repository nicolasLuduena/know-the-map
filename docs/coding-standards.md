# Coding standards

## Fail loudly

No silent defaults, placeholder success, or swallowed rejections; a loud
failure beats a silent wrong answer. Undesigned code fails with
`NotImplementedError` from `@know-the-map/harness`. No blanket fallbacks
(`Effect.catch`, broad `try/catch`) "just in case" — handle exactly the
tagged errors a channel declares; let the unexpected crash.

## Preconditions

When types or Schema can't guarantee a precondition, assert it at the
function boundary. Functions defend assumptions instead of trusting callers:
loose coupling, local failures.

## Gates

`bun run check` · `bun run typecheck` · `bun test packages apps` — all must pass.

## TypeScript

`verbatimModuleSyntax`; `.ts` extensions in relative imports; guards over `!`.
Comments only for nuance or complexity — the why, not the what.

## Schemas

Strict types: literals/unions over bare strings/numbers, narrow checks
(`PositiveInt`) over accepting anything. Every field documents itself via
`.annotate({ description })`, not TS comments — descriptions flow into error
messages and generated JSON schemas.

## Effect

`Effect.gen`/`Effect.fn`, combinators in `.pipe` (per the Effect skill — load
it before writing Effect code). Services: `Context.Service` + static `Layer`;
errors: `Schema.TaggedError`. Keep errors typed — no `Exit`/`flip` gymnastics.

## Monorepo

`catalog:` shared versions, `workspace:*` internal, `@know-the-map/*` scope;
`packages/*` libs, `apps/*` executables. `harness-probe/` reference-only:
transplant, never import.
