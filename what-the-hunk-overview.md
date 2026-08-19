# What the Hunk? — Condensed Overview

Condensed from [what-the-hunk-architecture.md](./what-the-hunk-architecture.md).

## What WTH is

A headless, stateless diff-analysis engine. The terminal UI is one client of the
engine, not the application itself.

> Keep domain values and invariants stable; make integrations, policies, and
> behaviors customizable.

`Hunk`, `DiffSnapshot`, and `ReviewFinding` are core types. How a diff is
obtained, which context is collected, how a hunk is explained, and where results
are cached are plugin-provided capabilities.

## Domain model

Pure, serializable values validated with `Effect.Schema` — no process execution,
HTTP, or UI code in the domain package.

- `DiffSnapshot` — id, base/head revisions, files
- `FileDiff` — path, status, hunks
- `Hunk` — id, old/new line ranges, lines
- `HunkExplanation` — summary, intent, behavior changes, risks, confidence
- `ReviewFinding` — core review result type

Hunk IDs are derived from normalized content
(`hash(file path + ranges + hunk contents)`), making explanations, questions,
annotations, and viewed status stable across UI restarts.

## Plugin capabilities

Explicit, named capabilities — no generic `onBeforeAnything`/`onAfterAnything`
hooks. Implementations are Effect services/layers.

| Capability | Examples |
| --- | --- |
| `DiffSource` | Local Git, GitHub PR, pasted patch |
| `ContextProvider` | LSP, syntax tree, textual search, Git history |
| `Analyzer` | Explanation, correctness review, security review |
| `AgentRunner` | OpenCode V2, direct model API, local model |
| `CacheStore` | Memory, SQLite, filesystem |
| `ReviewStore` | Annotations, viewed hunks, question threads |
| `PromptPolicy` | Terse, beginner, repository-specific guidance |
| `LanguageServerDefinition` | TypeScript, Rust, Go language-server commands |

**Not plugin-replaceable:** domain schemas, hunk identity, cancellation
semantics, plugin API versioning, permission boundaries, core event/error
protocols.

## Stateless review API

"Stateless" = no hidden server-side review session. Persistence is externalized
behind `CacheStore`/`ReviewStore`; a client can use SQLite or be fully ephemeral.

```ts
resolveDiff(input)            → Effect<DiffSnapshot, DiffError>
explainHunk(input)            → Stream<ExplanationEvent, AnalysisError>
askAboutHunk(input)           → Stream<AnswerEvent, AnalysisError>
reviewDiff(input)             → Stream<ReviewEvent, ReviewError>
```

Question history is supplied by the client. First implementation is an
in-process TypeScript API (`TUI → ReviewApi → ReviewEngine`); the same schemas
can later be exposed over HTTP or stdio JSON-RPC without rewriting the engine.

## Scheduling

One central `AnalysisScheduler` — global backpressure, not scattered
`Promise.all` limits. Supports: per-backend concurrency, priorities (visible >
adjacent > background), deduplication, cancellation on diff change/navigation,
retry with backoff (transient failures only), rate-limit/`Retry-After`
handling, token/cost budgets, and cache lookup before acquiring an agent permit.

## Agent runners

`AgentRunner` is the boundary — OpenCode is an adapter, not domain. The first
planned implementation is `OpenCodeV2Runner` over a structured client/server
boundary. The current foundation deliberately registers no OpenCode runner;
when the adapter lands, only that capability implementation changes.

## Semantic context and LSP

The model never consumes raw LSP responses. A context-planning layer turns
semantic results into small, ranked excerpts:

```text
Hunk → Context planner → LSP · AST · Search · Git → ranked bundle → analyzer
```

- `CodeIntelligence` — symbol/references/calls/definitions/hover/diagnostics
- `ContextProvider` — returns neutral `ContextFragment` values (source, uri,
  range, symbol, excerpt, reason), emitted in descending value order so the
  UI can show provenance without understanding providers
- `ContextPolicy` — max references per symbol, include
  tests/incoming/outgoing calls, traversal depth; the planner enforces its
  own token budget by truncating provider streams
- LSP references return locations, not code — WTH parses the actual call
  expression and sends concise call-site excerpts

## Language-server lifecycle

Stateful subprocesses behind the stateless API. `LanguageServerManager` starts
servers lazily per workspace+language, negotiates capabilities, serializes
JSON-RPC, restarts crashed servers with backoff, shuts down after idle timeout,
and forwards Effect interruption as LSP cancellation. An Effect scope owns the
whole lifecycle.

Servers must analyze the same tree as the diff's head revision. MVP requires a
checked-out branch (`wth main...HEAD`); later a `WorkspaceMaterializer` creates
an isolated temporary worktree (e.g. for remote PRs), closed via Effect scope.

WTH never silently downloads or runs language servers — it detects installed
ones and requires explicit configuration.

## Layout

```text
packages/  domain · engine · scheduler · plugin-api · api · tui
plugins/   git · opencode-v2 · sqlite · github · lsp-client · lsp-typescript · context-lsp-semantic
```

Generic LSP protocol support is separate from individual language-server
definitions. Plugin-provided UI components are postponed — plugins contribute
analyzers/commands/actions/result sections; the TUI owns rendering.

## Initial vertical slice

```text
git diff → normalized hunks → select one hunk → resolve enclosing symbol
  → collect bounded LSP/AST context → check content-addressed cache
  → acquire OpenCode permit → stream explanation into TUI
```

Validates the domain model, plugin contracts, semantic context, Effect
scheduler, OpenCode adapter, streaming UI, cancellation, and caching.

## MVP scope

Cut implementations, never boundaries. Every package exists, every capability
contract is defined, but only one implementation per capability where needed.

### In MVP

| Piece | Notes |
| --- | --- |
| `packages/domain` | Full schemas, IDs, content-hash hunk identity |
| `packages/plugin-api` | Versioned contracts for all 8 capabilities |
| `packages/api` | `resolveDiff`, `explainHunk`, `askAboutHunk` |
| `packages/engine` | Use-case orchestration |
| `packages/scheduler` | Trimmed: per-backend concurrency, dedup, cache-before-permit, cancellation, `visible` priority; no-op hooks for retry/rate-limit/cost budgets |
| `packages/tui` | Hunk list, streaming explanation, follow-up ask |
| `plugins/git` | Local `git diff` → hunks; empty `ContextFragment` provider to exercise the pipeline shape |
| `plugins/opencode-v2` | `AgentRunner` over the V2 client/server boundary |
| `plugins/sqlite` | Content-addressed cache + review store |

### Deferred (contract defined, no implementation)

- All LSP: `lsp-client`, `lsp-typescript`, `context-lsp-semantic`,
  `LanguageServerManager`, `WorkspaceMaterializer`, `CodeIntelligence`
- `plugins/github` — requires the materializer; MVP uses local checkout
- `reviewDiff` full-diff review — `ReviewFinding` schema exists, no analyzer yet
- Scheduler priorities beyond `visible`, retries, rate limits, cost budgets

### MVP slice (cut)

```text
git diff → hunks → select hunk → cache check → acquire OpenCode permit
        → stream explanation into TUI → ask follow-up
```

### Non-negotiables even at MVP

Schema validation, content-hash hunk identity, cancellation (Effect
interruption), plugin API versioning, streamed events.
