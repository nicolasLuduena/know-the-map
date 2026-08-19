# AGENTS.md

## What this is

What the Hunk? (WTH) is a headless, stateless diff-analysis engine: explains
hunks from a `git diff` via an agent runner (OpenCode V2), collecting semantic
context, with a terminal UI built on OpenTUI.

Read `what-the-hunk-architecture.md` (full design) and
`what-the-hunk-overview.md` (condensed + MVP scope) before architectural
decisions.

Central rule: **keep domain values and invariants stable; make integrations,
policies, and behaviors customizable.** Cut implementations, never boundaries.

## Layout

Bun workspaces: root `package.json` declares `packages/*` and `plugins/*`.

- `packages/domain` — `@bleentr/domain` — Effect.Schema-branded IDs, immutable
  diff types. Serializable values only; no process/HTTP/UI code.
- `packages/plugin-api` — `@bleentr/plugin-api` — the 8 versioned capability
  contracts, scoped `PluginRegistry`, and `definePlugin`.
- `packages/api` — `@bleentr/api` — transport-independent `ReviewApi`
  (`resolveDiff`, `explainHunk`, `askAboutHunk`, `reviewDiff`).
- `packages/engine` — `@bleentr/engine` — use cases and orchestration.
- `packages/scheduler` — `@bleentr/scheduler` — concurrency, priorities,
  deduplication (`AnalysisScheduler`).
- `packages/tui` — `@bleentr/tui` — reserved for the terminal client. The
  OpenTUI implementation is deferred; it will be one client of the API, not
  the app itself.
- `plugins/git` — `@bleentr/plugin-git` — local `git diff` → hunks.
- `plugins/opencode-v2` — `@bleentr/plugin-opencode-v2` — reserved adapter
  package; no runner is registered until structured streaming and cancellation
  are implemented.
- `plugins/sqlite` — `@bleentr/plugin-sqlite` — scoped content-addressed cache.

Contracts defined, no implementation yet: `ReviewStore`, OpenCode,
`plugins/github`, `plugins/lsp-*`, `plugins/context-lsp-semantic`,
`LanguageServerManager`, `WorkspaceMaterializer`, `CodeIntelligence`.

## Commands

Bun is the package manager and runtime. `bun.lock` is committed; CI uses
`bun install --frozen-lockfile`.

- `bun run typecheck` — `tsc --noEmit` in every workspace package
- `bun run test` — runtime tests for contracts, layers, cancellation, and integrations
- `bun run lint` — Biome check (lint + format) over the whole repo
- `bun run format` — Biome format --write
- `bun run check` — typecheck + lint

## Conventions

- npm scope is `@bleentr/*` (the `@wth` scope is not owned). Internal plugin
  IDs are still `wth.*` (e.g. `wth.git`).
- Every package is `"type": "module"` and exports TS source directly
  (`"exports": { ".": "./src/index.ts" }`); no build step.
- Dependency direction is top-down: `tui → api → engine → plugin-api → domain`.
  `plugins/` depend only on `@bleentr/plugin-api`, `@bleentr/api`, and
  `@bleentr/domain` (domain is values-only and already a plugin-api
  dependency) — never on engine/scheduler/tui internals. `domain` depends on
  nothing in WTH. Exception: `tui` may import `@bleentr/scheduler` and
  `@bleentr/plugin-api` directly for layer assembly (composition root).
  Keep each `package.json` `dependencies` honest.
- TypeScript strict (see `tsconfig.base.json`): strict, exact optional
  property types, `verbatimModuleSyntax`, `isolatedModules`, bundler
  resolution, `noEmit`. Use `import type` for type-only imports.
- Immutable values: `readonly` fields, `ReadonlyArray`.
- Domain values validated with `Effect.Schema` (IDs branded). Hunk IDs derive
  from normalized content — `hash(file path + old range + new range +
  normalized hunk contents)` — stable across UI restarts.
- Capabilities are explicit and named; no generic `onBeforeAnything` /
  `onAfterAnything` hooks. Not plugin-replaceable: domain schemas, hunk
  identity, cancellation semantics, plugin API versioning, permission
  boundaries, event/error protocols.
- Plugins contribute capabilities (sources, analyzers, commands, result
  sections); the TUI owns rendering. No plugin-provided UI components.
- OpenCode is an adapter, not domain: the boundary is `AgentRunner`, never an
  `OpenCodeService` in the domain model.
- Plugins are scoped builders aggregated once into `PluginRegistry`. Never
  merge multiple layers that publish the same aggregate capability tags.

# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.
