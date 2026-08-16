# WTH Effect adoption — parallel execution plan

Goal: take full advantage of Effect v3 (pinned 3.22.1). Decisions locked:
error protocol owned by `@bleentr/api` (`Schema.TaggedError`); capabilities get
**additive** aggregate service tags (contracts unchanged, `PLUGIN_API_VERSION` stays 1);
`DateTime.Utc` + `Option` for optional/timestamps; scheduler per MVP scope
(per-backend semaphores, dedup, visible-first priority, interruption-safe).

## Waves & units

| Wave | Unit | Package | Files |
| --- | --- | --- | --- |
| 1 | domain | @bleentr/domain | packages/domain/src/index.ts |
| 2 | plugin-api | @bleentr/plugin-api | packages/plugin-api/src/index.ts |
| 2 | api-core | @bleentr/api | packages/api/src/index.ts |
| 3 | scheduler | @bleentr/scheduler | packages/scheduler/src/index.ts |
| 3 | plugin-git | @bleentr/plugin-git | plugins/git/src/index.ts, plugins/git/package.json |
| 3 | plugin-opencode-v2 | @bleentr/plugin-opencode-v2 | plugins/opencode-v2/src/index.ts, plugins/opencode-v2/package.json |
| 3 | plugin-sqlite | @bleentr/plugin-sqlite | plugins/sqlite/src/index.ts, plugins/sqlite/package.json |
| 4 | engine+api-live | @bleentr/engine, @bleentr/api | packages/engine/src/index.ts, packages/engine/package.json, packages/api/src/index.ts (append), packages/api/package.json |
| 5 | tui | @bleentr/tui | packages/tui/src/index.ts, packages/tui/package.json |

## Unit contracts (summary)

- **domain**: full schemas (Struct/Literal/OptionFromUndefinedOr/DateTimeUtc not needed
  here), branded ID constructors (`makeSnapshotId`, `makeRevision`, `makeRepoPath`),
  `deriveHunkId` (sha256 of path+ranges+normalized lines), decode/encode helpers.
- **plugin-api**: 5 capability errors → `Schema.TaggedError`; `AgentEvent` schema;
  `ContextFragment`/`CacheEntry` schemas with `Option`/`DateTime.Utc`;
  `CacheStore.get` → `Effect<Option<CacheEntry>, CacheError>`; `DiffSourceInput.cwd?`
  added; aggregate service tags (`DiffSources`, `ContextProviders`, `Analyzers`,
  `AgentRunners`, `CacheStores`, `ReviewStores`, `PromptPolicies`,
  `LanguageServerDefinitions`) + `capabilityLayers()`.
- **api-core**: protocol `DiffError`/`AnalysisError`/`ReviewError` (Schema.TaggedError),
  `AnswerEvent`/`ReviewEvent` schemas (ReviewEvent.Finding uses domain `ReviewFinding`),
  `ReviewApi` interface with per-method error channels, `ReviewApiService` tag.
- **scheduler**: `SchedulerError` (TaggedError), generic `SchedulerSubmitInput<A,E>`,
  `AnalysisSchedulerService` — per-priority `Queue`s, per-backend `Semaphore` (1 permit),
  in-flight `Deferred` dedup by key, `submit` returns `Effect<A, E | SchedulerError>`.
- **plugins**: git diff parser → domain-validated `DiffSnapshot` (+ empty context
  provider); opencode-v2 `AgentRunner` streaming via `opencode run` subprocess seam;
  sqlite `CacheStore`+`ReviewStore` via `bun:sqlite` (per-call open/close, MVP).
- **engine+api-live**: `ReviewEngineService` (Effect.fn entry points, plugin selection,
  schema validation at boundaries, cache-before-submit, `catchTags` mapping);
  `ReviewApiLive` in api wraps engine → protocol errors.
- **tui**: `reviewApiLayer(plugins)` composing `ReviewApiLive.Default`,
  `ReviewEngineService.Default`, plugin `capabilityLayers()`, `ConfigProvider` wiring.

## Verification

Per unit: `bun run typecheck` + `bunx biome check <files>` in the touched package.
After each wave: overview agent(s) verify diff + run checks.
Final: `bun run check` at root (typecheck all workspaces + biome).
Never commit.
