# Coding standards

Living document — updated whenever a preference is settled or disgusting code
gets corrected. Read it completely before writing TypeScript here.

## Fail loudly

Never hide errors. No silent defaults, no placeholder success, no swallowed
rejections. Undesigned code fails with `NotImplementedError` from
`@know-the-map/harness`. A loud failure beats a silent wrong answer.

This includes catch-alls: do not add blanket fallbacks (`Effect.catch`,
broad `try/catch`) "just in case". Handle exactly the tagged errors the
channel declares; let anything unexpected crash loudly instead of turning
into a generic "unexpected failure" message.

## Preconditions

When Effect Schema or the type system cannot guarantee a precondition, assert
it explicitly at the function boundary. Functions defend their assumptions
instead of trusting callers — this keeps coupling loose and failures local.

## Gates

`bun run check` · `bun run typecheck` · `bun test packages apps` — all must
pass.

## TypeScript

- `verbatimModuleSyntax`: `export type` / `import type` for type-only usage.
- `.ts` extensions in relative imports.
- Guards over `!` non-null assertions.
- Comments only when a function carries context nuance or crosses a
  complexity threshold. Keep them compact: explain the why, not the what.

## Effect

- `Effect.gen` / `Effect.fn` with combinators in `.pipe` (see `AGENTS.md`).
- Services: `Context.Service` + static `Layer`. Errors: `Schema.TaggedError`.
- Keep errors typed; no `Exit`/`flip` gymnastics. Cross to imperative land
  once: `Effect.as(0)` *before* the `Effect.catchTag` handlers that report
  and return the exit code, then one `Effect.runPromise`.

## Monorepo

- `catalog:` for shared versions, `workspace:*` for internal packages,
  `@know-the-map/*` scope; `packages/*` for libraries, `apps/*` for
  executables.
- `harness-probe/` is reference-only; transplant ideas, never import.
