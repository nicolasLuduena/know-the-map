# Production Foundation Review Guide

This guide reviews What the Hunk? from the smallest stable values to the full
runtime flow. The implementation is intentionally a production foundation, not
a feature-complete application: stable boundaries are real and tested, while
unfinished integrations are named as unfinished instead of being represented by
placeholder behavior.

## Start with the working behavior

Run the same checks as CI:

```sh
bun install --frozen-lockfile
bun run check
bun run test
```

For the shortest functional tour, read and run
[`integration/runtime.test.ts`](integration/runtime.test.ts). It creates a real
temporary Git repository, resolves a diff through the Git plugin, and exercises
the SQLite cache while both plugins coexist in the same registry. This proves
the foundational composition without depending on an LLM, network service, or
terminal renderer.

The runtime path under review is:

```text
caller
  -> ReviewApi input validation
  -> ReviewEngine orchestration
  -> AnalysisScheduler admission and deduplication
  -> PluginRegistry capability lookup
  -> Git / context / analyzer / cache capability
  -> validated domain value or validated event stream
```

## 1. Domain values: the leaves

Read:

- [`packages/domain/src/index.ts`](packages/domain/src/index.ts)
- [`packages/domain/src/index.test.ts`](packages/domain/src/index.test.ts)

Verify these invariants first because every higher layer relies on them:

- IDs are branded values rather than interchangeable strings.
- Values are immutable and serializable.
- A line range is positive and inclusive, except Git's valid `0..0` empty-side
  sentinel.
- Hunk identity is derived from normalized content, path, and ranges.
- Snapshot identity includes resolved revisions and normalized files.
- Optional serialized fields use ordinary optional properties, not runtime
  container types.

These rules are not plugin customization points. Changing one is a data-model
migration, not an adapter change.

## 2. Capability contracts: what can vary

Read:

- [`packages/plugin-api/src/index.ts`](packages/plugin-api/src/index.ts)
- [`packages/plugin-api/src/index.test.ts`](packages/plugin-api/src/index.test.ts)

The plugin API retains eight named capabilities: diff sources, context
providers, analyzers, agent runners, cache stores, review stores, prompt
policies, and language-server definitions.

The important separation is:

- Contracts describe inputs, outputs, errors, metadata, and lifetimes.
- Plugins contribute capabilities; they do not replace domain identity,
  cancellation, event protocols, permissions, or API versioning.
- `PluginDefinition.build` is scoped, so acquired resources have deterministic
  release.
- `PluginRegistry` aggregates contributions and rejects incompatible API
  versions and duplicate plugin or capability IDs at startup.

To add an implementation, create a plugin with `definePlugin`, acquire its
resources in `build`, and return only the capabilities it actually implements.
Do not add a fake capability merely to fill a slot.

## 3. Concrete leaf adapters

### Git diff source

Read:

- [`plugins/git/src/index.ts`](plugins/git/src/index.ts)
- [`plugins/git/src/index.test.ts`](plugins/git/src/index.test.ts)

Follow `makeGitPlugin` into the `DiffSource.resolve` implementation. It resolves
mutable revision names to commit hashes, reads raw NUL-delimited metadata
separately from the textual patch, and converts the result into domain values.
The test uses a real repository and covers spaces, renames, deletions, and
files without ordinary hunks.

Process execution is scoped and interruptible. Standard output and standard
error are drained concurrently, avoiding the common child-process deadlock
where one pipe fills while the other is being read.

### SQLite cache

Read:

- [`plugins/sqlite/src/index.ts`](plugins/sqlite/src/index.ts)
- [`plugins/sqlite/src/index.test.ts`](plugins/sqlite/src/index.test.ts)

`makeSqlitePlugin` requires an explicit database path, acquires one scoped
connection, applies versioned schema migration, and contributes a cache store.
Expiration is evaluated with Effect's clock, making the policy testable.

The `ReviewStore` contract remains available, but there is no pretend SQLite
review-store implementation yet.

## 4. Scheduler: controlled execution

Read:

- [`packages/scheduler/src/index.ts`](packages/scheduler/src/index.ts)
- [`packages/scheduler/src/index.test.ts`](packages/scheduler/src/index.test.ts)

The scheduler is a policy layer, not an analysis implementation. Check that:

- global and per-backend concurrency are enforced before dequeueing work;
- visible work outranks adjacent work, which outranks background work;
- identical keys share one underlying task;
- interrupting one subscriber does not cancel work needed by another;
- interrupting the final subscriber removes queued work or interrupts running
  work.

This is the correct extension point for future fairness or admission policies.
It should not learn Git, analyzer, UI, or cache behavior.

## 5. Engine: orchestration and protocol enforcement

Read:

- [`packages/engine/src/index.ts`](packages/engine/src/index.ts)
- [`packages/engine/src/index.test.ts`](packages/engine/src/index.test.ts)

Review the four use cases independently:

1. `resolveDiff` selects the configured diff source and validates its snapshot.
2. `explainHunk` finds the hunk, gathers bounded context, checks the cache,
   schedules analyzer work, validates events, and caches the final explanation.
3. `askAboutHunk` gathers the same context and delegates a constructed message
   sequence to the selected agent runner.
4. `reviewDiff` gathers a snapshot-wide bounded context set and streams findings.

Analyzer streams are untrusted adapter output. The engine validates every event
and requires exactly one terminal `Complete`. It withholds the adapter's raw
terminal event, performs finalization, and emits a single validated terminal
event to callers. Concurrent callers share active work and receive replayed
events; the final departing subscriber cancels the underlying task.

Configuration names capabilities explicitly. There is no "first registered
plugin wins" behavior, which keeps selection deterministic as implementations
are added.

## 6. API: transport-independent boundary

Read [`packages/api/src/index.ts`](packages/api/src/index.ts).

`ReviewApi` is a client-facing boundary over the engine, not an HTTP server and
not the TUI. It validates request schemas, maps engine failures to stable API
errors, and preserves streaming for long-running analysis. A future HTTP, RPC,
CLI, or in-process client can adapt this interface without importing engine
internals.

## 7. Composition: the full foundation

A production composition root should construct layers in this order:

1. Build the required plugins with explicit configuration.
2. Build one `PluginRegistry` from all plugin definitions.
3. Supply scheduler and engine configuration.
4. Construct `ReviewEngine`.
5. Construct `ReviewApi`.
6. Attach a transport or UI client.

The dependency direction stays:

```text
tui -> api -> engine -> plugin-api -> domain
                 |
                 +-> scheduler

plugins -------------------------> plugin-api / domain
```

The TUI is allowed to assemble layers, but plugins never import engine,
scheduler, or TUI internals. Plugins contribute data and behavior; the TUI owns
rendering.

## 8. Deliberately deferred work

These are extension slots, not deleted production requirements:

- OpenCode V2 `AgentRunner` adapter, including real client/server lifecycle and
  cancellation.
- SQLite-backed `ReviewStore`.
- GitHub diff source and workspace materialization.
- Language-server management and semantic context providers.
- OpenTUI application and rendering.

Implement each behind its existing boundary. A deferred package should remain
small and truthful until it can satisfy its contract under failure,
cancellation, resource-lifetime, and integration tests.

## Suggested review order

For a focused code review, use this order:

1. Domain tests and schemas.
2. Plugin capability types and registry tests.
3. Git and SQLite adapter tests, then their implementations.
4. Scheduler tests, then its dispatcher.
5. Engine test, then each engine use case.
6. API request/error mapping.
7. The real composition test.
8. Architecture and overview documents for consistency with the code.

At every layer ask two questions: which invariant is owned here, and which
behavior is intentionally delegated to a lower or replaceable capability? If
the answer is unclear, the boundary is probably leaking.
