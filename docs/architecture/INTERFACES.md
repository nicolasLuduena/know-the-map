# Know the Map by Bleentr — Proposed Interfaces and Module Ownership

> **Status:** Companion proposal to
> [`PROPOSED_ARCHITECTURE.md`](./PROPOSED_ARCHITECTURE.md).
>
> These TypeScript interfaces describe module boundaries and behavior. They are
> intentionally not a complete implementation or wire protocol.

## Interface philosophy

Know the Map should expose one substantial façade per deep module, not one service per
table or operation.

```text
ReviewApi
  └─ ApplicationServer
       ├─ RepositoryWorkspace
       ├─ KnowledgeBase
       └─ IntelligenceEngine
            ├─ RepositoryWorkspace
            ├─ KnowledgeBase
            └─ HarnessRuntime
```

The interfaces hide decisions that callers should not need to understand:

- `RepositoryWorkspace` hides Git, filesystem access, hashing, and anchor
  relocation.
- `KnowledgeBase` hides SQLite, transactions, migrations, search indexes, and
  wiki-version assembly.
- `IntelligenceEngine` hides task graphs, prompts, recursive agents, routing,
  budgets, and synthesis.
- `HarnessRuntime` hides Pi sessions, providers, model messages, and
  permissions.
- `ReviewApi` hides application composition and transport.

Methods returning incremental work use `Effect.Stream`. Finite operations use
`Effect.Effect`. Cancellation is Effect interruption rather than a separate
boolean flag threaded through every call.

## Shared identifiers

IDs are branded strings and are not interchangeable.

```ts
type RepositoryId = string & Brand<"RepositoryId">
type SnapshotId = string & Brand<"SnapshotId">
type WikiVersionId = string & Brand<"WikiVersionId">
type ComponentId = string & Brand<"ComponentId">
type ComponentVersionId = string & Brand<"ComponentVersionId">
type CodeAnchorId = string & Brand<"CodeAnchorId">
type InterpretationId = string & Brand<"InterpretationId">
type InterpretationChangeId = string & Brand<"InterpretationChangeId">
type ReviewDraftId = string & Brand<"ReviewDraftId">
type AnalysisRunId = string & Brand<"AnalysisRunId">
type AnalysisTaskId = string & Brand<"AnalysisTaskId">
type FlowId = string & Brand<"FlowId">
type Hash = string & Brand<"Hash">
type RepoPath = string & Brand<"RepoPath">
```

All externally supplied values are validated with `Effect.Schema` before they
reach a domain module.

## Shared source values

```ts
type SnapshotSource =
  | { kind: "git"; revision: string }
  | { kind: "worktree"; baseRevision?: string }

type Snapshot = {
  id: SnapshotId
  repositoryId: RepositoryId
  source:
    | { kind: "git"; commit: string }
    | { kind: "worktree"; base: string; manifestHash: Hash }
  createdAt: string
}

type SourceScope =
  | { kind: "repository" }
  | { kind: "path"; path: RepoPath }
  | { kind: "symbol"; path: RepoPath; symbol: string }
  | {
      kind: "range"
      path: RepoPath
      startLine: number
      endLine: number
    }

type CodeAnchor = {
  id: CodeAnchorId
  snapshotId: SnapshotId
  scope: SourceScope
  contentHash: Hash
  contextHash?: Hash
}

type AnchorDraft = {
  scope: SourceScope
  expectedExcerpt?: string
  reason: string
}

type AnchorTransition = {
  sourceAnchorId: CodeAnchorId
  targetSnapshotId: SnapshotId
  state: "unchanged" | "relocated" | "changed" | "missing" | "ambiguous"
  targetAnchor?: CodeAnchor
  reason: string
}
```

An AI task may propose an `AnchorDraft`. Only `RepositoryWorkspace` can turn it
into a verified `CodeAnchor`.

## Shared knowledge values

```ts
type PathOrSymbolSelector =
  | { kind: "path"; pattern: string }
  | { kind: "symbol"; path: RepoPath; symbol: string }

type ComponentDescriptor = {
  id: ComponentId
  name: string
  description: string
  selectors: ReadonlyArray<PathOrSymbolSelector>
  childCount: number
  keywords: ReadonlyArray<string>
  coverage: "complete" | "partial" | "unknown"
}

type ComponentVersion = ComponentDescriptor & {
  versionId: ComponentVersionId
  snapshotId: SnapshotId
  parentId?: ComponentId
  manifestHash: Hash
  brief: string
  origin: "ai" | "user"
  lockedByUser: boolean
}

type InterpretationKind =
  | "responsibility"
  | "behavior"
  | "flow"
  | "invariant"
  | "decision"
  | "risk"
  | "note"

type InterpretationAuthor =
  | {
      kind: "ai"
      harness: string
      model: string
      analysisRunId: AnalysisRunId
    }
  | { kind: "user"; userId: string; displayName?: string }

type Interpretation = {
  id: InterpretationId
  componentId: ComponentId
  kind: InterpretationKind
  body: string
  author: InterpretationAuthor
  assurance: "observed" | "inferred" | "unverified"
  basedOn: ReadonlyArray<CodeAnchorId>
  dependsOn: ReadonlyArray<InterpretationId>
  supersedes: ReadonlyArray<InterpretationId>
  createdAtSnapshot: SnapshotId
  lifecycle: "proposed" | "accepted" | "superseded" | "dismissed"
}

type InterpretationDraft = {
  componentId: ComponentId
  kind: InterpretationKind
  body: string
  assurance: "observed" | "inferred" | "unverified"
  proposedAnchors: ReadonlyArray<AnchorDraft>
  basedOn?: ReadonlyArray<CodeAnchorId>
  dependsOn: ReadonlyArray<InterpretationId>
  supersedes: ReadonlyArray<InterpretationId>
}

type InterpretationFreshness = {
  interpretationId: InterpretationId
  targetSnapshotId: SnapshotId
  state: "current" | "possibly-affected" | "stale" | "orphaned"
  affectedAnchors: ReadonlyArray<AnchorTransition>
  reason: string
}

type AddUserInterpretationInput = {
  wikiVersionId: WikiVersionId
  componentId: ComponentId
  kind: InterpretationKind
  body: string
  assurance: "observed" | "inferred" | "unverified"
  basedOn: ReadonlyArray<CodeAnchorId>
  supersedes?: ReadonlyArray<InterpretationId>
  sourceAnswerId?: string
  user: { id: string; displayName?: string }
}

type ContextLevel = "descriptor" | "brief" | "interpretations" | "evidence"

type ComponentContext = {
  component: ComponentVersion
  interpretations: ReadonlyArray<{
    interpretation: Interpretation
    freshness?: InterpretationFreshness
  }>
  evidence: ReadonlyArray<CodeAnchor>
  children: ReadonlyArray<ComponentDescriptor>
  coverageGaps: ReadonlyArray<CoverageGap>
}
```

## Shared review values

```ts
type InterpretationRelation =
  | "preserved"
  | "strengthened"
  | "weakened"
  | "revised"
  | "contradicted"
  | "obsolete"
  | "unknown"
  | "introduced"

type InterpretationChange = {
  id: InterpretationChangeId
  componentId: ComponentId
  baseInterpretationId?: InterpretationId
  proposedHeadInterpretation?: InterpretationDraft
  relation: InterpretationRelation
  explanation: string
  baseEvidence: ReadonlyArray<CodeAnchorId>
  headEvidence: ReadonlyArray<CodeAnchorId>
}

type ReviewQuestion = {
  id: string
  componentIds: ReadonlyArray<ComponentId>
  question: string
  whyItMatters: string
  evidence: ReadonlyArray<CodeAnchorId>
  status: "open" | "answered" | "dismissed"
}

type ReviewDraft = {
  id: ReviewDraftId
  repositoryId: RepositoryId
  baseSnapshotId: SnapshotId
  headSnapshotId: SnapshotId
  baseWikiVersionId: WikiVersionId
  changes: ReadonlyArray<InterpretationChange>
  questions: ReadonlyArray<ReviewQuestion>
  coverageGaps: ReadonlyArray<CoverageGap>
  createdByRunId: AnalysisRunId
  status: "draft" | "decided" | "promoted" | "outdated"
}

type ReviewDecision = {
  reviewDraftId: ReviewDraftId
  interpretationChangeId: InterpretationChangeId
  decision: "accept" | "correct" | "dismiss" | "defer"
  replacement?: InterpretationDraft
  user: { id: string; displayName?: string }
  decidedAt: string
}
```

## 1. RepositoryWorkspace

### Responsibility

Provide safe, reproducible access to repository state and own every operation
that interprets a path, revision, diff, or source anchor.

```ts
interface RepositoryWorkspace {
  open(
    input: OpenRepositoryInput,
  ): Effect.Effect<Repository, RepositoryError>

  capture(
    repositoryId: RepositoryId,
    source: SnapshotSource,
  ): Effect.Effect<Snapshot, RepositoryError>

  manifest(
    snapshotId: SnapshotId,
    policy: ManifestPolicy,
  ): Effect.Effect<RepositoryManifest, RepositoryError>

  compare(
    baseSnapshotId: SnapshotId,
    headSnapshotId: SnapshotId,
  ): Effect.Effect<CodeChangeSet, RepositoryError>

  read(
    snapshotId: SnapshotId,
    selection: SourceSelection,
  ): Effect.Effect<SourceExcerpt, RepositoryError>

  readAnchor(
    anchorId: CodeAnchorId,
    targetSnapshotId?: SnapshotId,
  ): Effect.Effect<SourceExcerpt, RepositoryError>

  verifyAnchors(
    snapshotId: SnapshotId,
    drafts: ReadonlyArray<AnchorDraft>,
  ): Effect.Effect<ReadonlyArray<CodeAnchor>, AnchorVerificationError>

  transitionAnchors(
    anchorIds: ReadonlyArray<CodeAnchorId>,
    targetSnapshotId: SnapshotId,
  ): Effect.Effect<ReadonlyArray<AnchorTransition>, RepositoryError>
}
```

### Method behavior

#### `open`

Canonicalizes a user-selected root, verifies repository access, establishes the
filesystem boundary, and returns a stable `RepositoryId`. It does not index or
start a harness.

#### `capture`

Resolves an immutable snapshot. For a dirty working tree it hashes the complete
manifest and stores changed blobs required for later reproduction.

#### `manifest`

Returns a compact, budgeted description suitable for decomposition: paths,
languages, sizes, selected project metadata, and inexpensive structural hints.
It excludes ignored, secret, binary, and oversized content according to policy.

#### `compare`

Computes the exact base/head code transition: changed paths, statuses, hunks,
and inexpensive structural boundary hints. It does not make semantic claims.

#### `read` and `readAnchor`

Return bounded excerpts from an approved snapshot. Reads cannot escape the
repository or silently fall back to the current working tree.

#### `verifyAnchors`

Validates model-proposed paths and ranges against real source, calculates
hashes, rejects fabricated evidence, and produces canonical anchors.

#### `transitionAnchors`

Checks whether existing anchors are unchanged, relocated, changed, missing, or
ambiguous in another snapshot. Initial relocation may use exact content and
nearby-context hashes; richer symbol matching can be added internally.

### Values hidden by the module

```ts
type OpenRepositoryInput = {
  root: string
  secretPolicy?: SecretPolicy
}

type RepositoryManifest = {
  snapshotId: SnapshotId
  rootLabel: string
  files: ReadonlyArray<ManifestFile>
  projectHints: ReadonlyArray<ProjectHint>
  truncated: boolean
  omittedCounts: Record<string, number>
}

type CodeChangeSet = {
  baseSnapshotId: SnapshotId
  headSnapshotId: SnapshotId
  files: ReadonlyArray<FileChange>
  boundaryHints: ReadonlyArray<BoundaryChangeHint>
  contentHash: Hash
}
```

Callers know these domain values, but not Git commands, worktree locations,
filesystem handles, or hashing implementations.

## 2. KnowledgeBase

### Responsibility

Own the repository wiki, its history, search, provenance, freshness,
transactions, and human review decisions.

```ts
interface KnowledgeBase {
  registerSnapshot(
    snapshot: Snapshot,
  ): Effect.Effect<void, KnowledgeError>

  beginAnalysisRun(
    metadata: AnalysisRunMetadata,
  ): Effect.Effect<AnalysisRunId, KnowledgeError>

  completeAnalysisRun(
    runId: AnalysisRunId,
    outcome: AnalysisRunOutcome,
  ): Effect.Effect<void, KnowledgeError>

  publishIndex(
    publication: IndexPublication,
  ): Effect.Effect<WikiVersion, KnowledgeError>

  getWiki(
    snapshotId: SnapshotId,
  ): Effect.Effect<WikiVersion, KnowledgeNotFound>

  getComponentMap(
    wikiVersionId: WikiVersionId,
  ): Effect.Effect<ComponentTree, KnowledgeError>

  searchComponents(
    snapshotId: SnapshotId,
    query: string,
    limit: number,
  ): Effect.Effect<ReadonlyArray<ComponentDescriptor>, KnowledgeError>

  loadContext(
    request: LoadContextRequest,
  ): Effect.Effect<ReadonlyArray<ComponentContext>, KnowledgeError>

  search(
    request: KnowledgeSearchRequest,
  ): Effect.Effect<KnowledgeSearchResult, KnowledgeError>

  getAnchor(
    anchorId: CodeAnchorId,
  ): Effect.Effect<CodeAnchor, KnowledgeNotFound>

  listActiveInterpretations(
    wikiVersionId: WikiVersionId,
  ): Effect.Effect<ReadonlyArray<Interpretation>, KnowledgeError>

  addUserInterpretation(
    input: AddUserInterpretationInput,
  ): Effect.Effect<Interpretation, KnowledgeError>

  evaluateFreshness(
    input: FreshnessInput,
  ): Effect.Effect<FreshnessPublication, KnowledgeError>

  publishFreshness(
    publication: FreshnessPublication,
  ): Effect.Effect<void, KnowledgeError>

  findAffectedKnowledge(
    input: AffectedKnowledgeInput,
  ): Effect.Effect<AffectedKnowledge, KnowledgeError>

  loadReviewContext(
    input: ReviewContextRequest,
  ): Effect.Effect<ComponentReviewContext, KnowledgeError>

  publishReviewDraft(
    draft: ReviewDraftPublication,
  ): Effect.Effect<ReviewDraft, KnowledgeError>

  getReviewDraft(
    reviewDraftId: ReviewDraftId,
  ): Effect.Effect<ReviewDraft, KnowledgeNotFound>

  recordDecision(
    decision: ReviewDecision,
  ): Effect.Effect<ReviewDraft, KnowledgeError>

  promoteReview(
    reviewDraftId: ReviewDraftId,
  ): Effect.Effect<WikiVersion, KnowledgeError | ReviewOutdated>
}
```

### Method groups

#### Analysis provenance

`beginAnalysisRun` and `completeAnalysisRun` record what harness, model,
strategy, snapshot, inputs, and limits produced knowledge. They do not expose
provider-specific session data to the rest of the application.

#### Atomic publication

`publishIndex`, `publishFreshness`, and `publishReviewDraft` validate referential
integrity and commit complete domain aggregates in transactions. Callers cannot
insert components or interpretations one row at a time.

#### Wiki queries

`getWiki`, `getComponentMap`, `searchComponents`, `loadContext`, and `search`
provide use-case-oriented reads. The UI never issues SQL or assembles component
pages from tables itself.

#### Freshness

`evaluateFreshness` applies deterministic freshness rules to anchor transitions
and interpretation dependencies. It must not call a model.

`addUserInterpretation` records an explicit user action. It may save an edited
answer, correction, or independent note, but it still requires verified anchors
or an explicit repository/component scope.

#### Review lifecycle

`findAffectedKnowledge` groups changed knowledge by component.
`loadReviewContext` assembles accepted interpretations and user notes for an AI
task. `recordDecision` preserves user intent. `promoteReview` atomically creates
the next wiki version and refuses to promote against a changed head snapshot.

### Important publication values

```ts
type IndexPublication = {
  runId: AnalysisRunId
  snapshotId: SnapshotId
  components: ReadonlyArray<ComponentVersion>
  anchors: ReadonlyArray<CodeAnchor>
  interpretations: ReadonlyArray<Interpretation>
  coverageGaps: ReadonlyArray<CoverageGap>
}

type WikiVersion = {
  id: WikiVersionId
  repositoryId: RepositoryId
  snapshotId: SnapshotId
  previousVersionId?: WikiVersionId
  componentRootIds: ReadonlyArray<ComponentId>
  coverage: "complete" | "partial"
  publishedAt: string
}
```

### Implementation note

The MVP does not need a public persistence plugin. `KnowledgeBase` can own one
SQLite implementation directly. If a second real backend is required, extract
one deep persistence adapter from the working implementation rather than
inventing repository interfaces for every table now.

## 3. IntelligenceEngine

### Responsibility

Turn repository state and stored knowledge into bounded AI tasks and validated
knowledge proposals.

```ts
interface IntelligenceEngine {
  index(
    request: IndexRequest,
  ): Stream.Stream<IndexEvent, IntelligenceError>

  refresh(
    request: RefreshRequest,
  ): Stream.Stream<RefreshEvent, IntelligenceError>

  ask(
    request: AskRequest,
  ): Stream.Stream<AnswerEvent, IntelligenceError>

  review(
    request: ReviewRequest,
  ): Stream.Stream<ReviewEvent, IntelligenceError>

  explore(
    request: ExplorationRequest,
  ): Stream.Stream<ExplorationEvent, IntelligenceError>
}
```

Only one public entry point is added for all demand-loaded, structured explorations;
each optional feature does not become its own service. The complexity stays behind
the Intelligence Engine.

### `index`

Builds or rebuilds a wiki for a snapshot. Internally it creates the repository
manifest, requests a component plan, recursively subdivides oversized
components, analyzes leaves, verifies anchors, and publishes atomically.

```ts
type IndexRequest = {
  repositoryId: RepositoryId
  snapshotId: SnapshotId
  policy: AnalysisPolicy
  strategyIds?: ReadonlyArray<string>
}

type IndexEvent =
  | { kind: "run-started"; runId: AnalysisRunId }
  | { kind: "component-planned"; component: ComponentDescriptor }
  | { kind: "component-started"; componentId: ComponentId }
  | { kind: "component-completed"; componentId: ComponentId }
  | { kind: "coverage-gap"; gap: CoverageGap }
  | { kind: "completed"; wiki: WikiVersion }
```

### `refresh`

Captures a target snapshot, transitions existing anchors, publishes mechanical
freshness, and optionally reanalyzes only affected components.

```ts
type RefreshRequest = {
  repositoryId: RepositoryId
  baseWikiVersionId: WikiVersionId
  target: SnapshotSource
  revalidate: "none" | "affected" | "all"
  policy: AnalysisPolicy
}
```

### `ask`

Routes a question through component descriptors, loads briefs and
interpretations progressively, gives the harness bounded knowledge tools, and
streams a cited answer. It does not persist the answer automatically.

```ts
type AskRequest = {
  snapshotId: SnapshotId
  question: string
  preferredComponentIds?: ReadonlyArray<ComponentId>
  policy: QuestionPolicy
}

type AnswerEvent =
  | { kind: "routing"; candidates: ReadonlyArray<ComponentDescriptor> }
  | { kind: "component-loaded"; componentId: ComponentId; level: ContextLevel }
  | { kind: "text-delta"; text: string }
  | { kind: "evidence"; anchor: CodeAnchor }
  | { kind: "completed"; answer: Answer }
```

### `explore`

Runs an explicitly requested optional capability. Flow discovery and tracing are
separate requests so the first pass cannot accidentally expand every flow.

```ts
type ExplorationRequest =
  | {
      kind: "discover-flows"
      repositoryId: RepositoryId
      snapshotId: SnapshotId
      policy: AnalysisPolicy
    }
  | {
      kind: "trace-flow"
      repositoryId: RepositoryId
      snapshotId: SnapshotId
      flowId: FlowId
      policy: AnalysisPolicy
    }

type Assurance = "observed" | "inferred" | "unverified"

type FlowData = {
  name: string
  shape: string
  redactedExample?: unknown
}

type StateTransition = {
  subject: string
  before: string
  after: string
}

type FlowDescriptor = {
  id: FlowId
  name: string
  trigger: string
  outcome: string
  likelyComponentIds: ReadonlyArray<ComponentId>
  assurance: Assurance
  estimatedTraceCost: "low" | "medium" | "high"
}

type FlowStep = {
  order: number
  kind: "call" | "rpc" | "event" | "queue" | "read" | "write" | "transform"
  componentId: ComponentId
  targetComponentId?: ComponentId
  operation: string
  input?: FlowData
  output?: FlowData
  mutation?: StateTransition
  evidenceAnchorIds: ReadonlyArray<CodeAnchorId>
  assurance: Assurance
}

type FlowTrace = {
  flowId: FlowId
  snapshotId: SnapshotId
  steps: ReadonlyArray<FlowStep>
}

type FlowCatalogDraft = { flows: ReadonlyArray<FlowDescriptor> }
type FlowTraceDraft = FlowTrace

type ExplorationEvent =
  | { kind: "status"; message: string }
  | { kind: "flow-discovered"; flow: FlowDescriptor }
  | { kind: "flow-step"; step: FlowStep }
  | { kind: "completed"; result: ReadonlyArray<FlowDescriptor> | FlowTrace }
```

### `review`

Compares base and head, groups affected knowledge, performs parallel
component-level revalidation, optionally synthesizes cross-component impact,
and publishes a review draft.

```ts
type ReviewRequest = {
  repositoryId: RepositoryId
  baseSnapshotId: SnapshotId
  headSnapshotId: SnapshotId
  baseWikiVersionId: WikiVersionId
  strategyIds?: ReadonlyArray<string>
  policy: AnalysisPolicy
}

type ReviewEvent =
  | { kind: "run-started"; runId: AnalysisRunId }
  | { kind: "change-set-ready"; changeSetHash: Hash }
  | { kind: "component-started"; componentId: ComponentId }
  | {
      kind: "interpretation-change"
      change: InterpretationChange
    }
  | { kind: "question"; question: ReviewQuestion }
  | { kind: "coverage-gap"; gap: CoverageGap }
  | { kind: "completed"; review: ReviewDraft }
```

### Internal policies, not additional modules

```ts
type AnalysisPolicy = {
  maxDepth: number
  maxTasks: number
  maxConcurrentTasks: number
  maxInputTokensPerTask: number
  maxEstimatedCost?: number
  componentFileLimit: number
  failureMode: "strict" | "partial"
}

type QuestionPolicy = {
  maxCandidateComponents: number
  maxLoadedComponents: number
  maxEvidenceReads: number
  maxInputTokens: number
}
```

These are values consumed by `IntelligenceEngine`, not independent scheduler,
budget, decomposition, or routing services.

## 4. HarnessRuntime

### Responsibility

Execute an analysis task through a coding-agent harness while preserving product
permissions, cancellation, streaming, and result schemas.

```ts
interface HarnessRuntime {
  capabilities(): Effect.Effect<HarnessCapabilities, HarnessError>

  execute<Result extends AnalysisResult>(
    task: AnalysisTask<Result>,
    context: HarnessExecutionContext,
  ): Stream.Stream<HarnessEvent<Result>, HarnessError>
}
```

### Analysis tasks

```ts
type AnalysisTask<Result extends AnalysisResult = AnalysisResult> = {
  id: AnalysisTaskId
  kind:
    | "decompose-repository"
    | "explore-component"
    | "deduplicate-components"
    | "route-question"
    | "answer-question"
    | "discover-flows"
    | "trace-flow"
    | "revalidate-component"
    | "synthesize-cross-component"
  repositoryId: RepositoryId
  snapshotIds: ReadonlyArray<SnapshotId>
  instructions: string
  input: unknown
  resultSchema: Schema.Schema<Result>
  modelClass: "cheap" | "capable" | "strong"
  permissions: HarnessPermissionPolicy
  budget: TaskBudget
}

type AnalysisResult =
  | ComponentPlan
  | ComponentExplorationDraft
  | ComponentDeduplicationPlan
  | QuestionRoute
  | Answer
  | FlowCatalogDraft
  | FlowTraceDraft
  | ComponentReviewDraft
  | CrossComponentReviewDraft

type ComponentExplorationDraft = {
  analysis: ComponentAnalysisDraft
  childPlan?: ComponentPlan
}

type ComponentDeduplicationDecision =
  | {
      kind: "merge"
      canonicalId: ComponentId
      duplicateIds: ReadonlyArray<ComponentId>
      reason: string
    }
  | {
      kind: "shared-reference"
      componentId: ComponentId
      parentIds: ReadonlyArray<ComponentId>
      reason: string
    }
  | {
      kind: "keep-separate"
      componentIds: ReadonlyArray<ComponentId>
      reason: string
    }

type ComponentDeduplicationPlan = {
  decisions: ReadonlyArray<ComponentDeduplicationDecision>
}
```

The task carries a schema, so invalid model output is a harness failure rather
than partially accepted knowledge.

### Execution context and tools

```ts
type HarnessExecutionContext = {
  repositoryLocation: string
  tools: ReadonlyArray<HarnessTool>
}

type HarnessTool = {
  name: string
  description: string
  inputSchema: Schema.Schema<unknown>
  execute(input: unknown): Effect.Effect<unknown, ToolError>
}
```

The Intelligence Engine constructs bounded tools backed by the existing deep
modules:

```text
ktm_list_components    → KnowledgeBase.getComponentMap
ktm_load_component     → KnowledgeBase.loadContext
ktm_search_knowledge   → KnowledgeBase.search
ktm_read_code          → RepositoryWorkspace.read
ktm_read_evidence      → KnowledgeBase.getAnchor + RepositoryWorkspace.readAnchor
```

The tools expose only approved snapshots and repository-relative selections.

### Events

```ts
type HarnessEvent<Result> =
  | { kind: "session-started"; taskId: AnalysisTaskId }
  | { kind: "status"; message: string }
  | { kind: "tool-started"; tool: string }
  | { kind: "tool-completed"; tool: string }
  | { kind: "text-delta"; text: string }
  | { kind: "usage"; inputTokens: number; outputTokens: number; cost?: number }
  | { kind: "result"; value: Result }
```

### PiHarness

`PiHarness` is the first implementation. Its private responsibilities
are approximately:

```ts
class PiHarness implements HarnessRuntime {
  capabilities(): Effect.Effect<HarnessCapabilities, HarnessError>

  execute<Result extends AnalysisResult>(
    task: AnalysisTask<Result>,
    context: HarnessExecutionContext,
  ): Stream.Stream<HarnessEvent<Result>, HarnessError>

  // Private implementation details:
  private createModelRuntime(...): Effect.Effect<ModelRuntime, HarnessError>
  private createResourceLoader(...): Effect.Effect<ResourceLoader, HarnessError>
  private createTaskSession(...): Effect.Effect<AgentSession, HarnessError>
  private defineTaskTools(...): ReadonlyArray<AgentTool>
  private decodeSubmittedResult(...): Effect.Effect<Result, HarnessError>
}
```

Each execution uses `SessionManager.inMemory()` so analysis conversations do not
become an accidental persistence layer. The Effect scope subscribes to Pi events,
calls `session.abort()` when interrupted, and always calls `session.dispose()`.
Pi values, provider errors, and Promise-based lifecycle details are translated
before leaving this class.

## 5. ReviewStrategy

### Responsibility

Add a coherent interpretation or review lens without arbitrary hooks into the
engine lifecycle.

This is an extension contract, not necessarily a separately published package
in the MVP.

```ts
interface ReviewStrategy {
  readonly id: string
  readonly version: string
  readonly description: string

  interpretationKinds(): ReadonlyArray<InterpretationKind>

  componentGuidance(
    input: ComponentStrategyInput,
  ): Effect.Effect<StrategyGuidance, StrategyError>

  reviewGuidance(
    input: ChangeStrategyInput,
  ): Effect.Effect<StrategyGuidance, StrategyError>
}
```

Examples include general architecture, security boundaries, performance, or
repository-specific conventions. A strategy contributes instructions,
questions, evidence preferences, and result sections. It cannot alter anchor
validation, freshness, permissions, user decisions, or publication semantics.

Multiple strategies are composed by the Intelligence Engine in declared order
and recorded in the `AnalysisRun`.

## 6. ReviewApi

### Responsibility

Expose product use cases to the web client or a future editor client without
leaking module or transport internals.

```ts
interface ReviewApi {
  openRepository(
    request: OpenRepositoryRequest,
  ): Effect.Effect<OpenRepositoryResult, ApiError>

  indexRepository(
    request: IndexRequest,
  ): Stream.Stream<IndexEvent, ApiError>

  getWiki(
    snapshotId: SnapshotId,
  ): Effect.Effect<WikiView, ApiError>

  getComponent(
    request: GetComponentRequest,
  ): Effect.Effect<ComponentView, ApiError>

  searchKnowledge(
    request: KnowledgeSearchRequest,
  ): Effect.Effect<KnowledgeSearchResult, ApiError>

  ask(
    request: AskRequest,
  ): Stream.Stream<AnswerEvent, ApiError>

  addUserInterpretation(
    request: AddUserInterpretationInput,
  ): Effect.Effect<Interpretation, ApiError>

  refreshWiki(
    request: RefreshRequest,
  ): Stream.Stream<RefreshEvent, ApiError>

  review(
    request: ReviewRequest,
  ): Stream.Stream<ReviewEvent, ApiError>

  getReviewDraft(
    reviewDraftId: ReviewDraftId,
  ): Effect.Effect<ReviewView, ApiError>

  decide(
    decision: ReviewDecision,
  ): Effect.Effect<ReviewView, ApiError>

  promoteReview(
    reviewDraftId: ReviewDraftId,
  ): Effect.Effect<WikiView, ApiError>
}
```

### Transport mapping

Finite calls map naturally to HTTP request/response. Streams map to WebSocket or
Server-Sent Events with stable operation IDs. The transport adapter validates
schemas and maps structured errors; it does not implement use cases.

The public protocol may split views from domain records to avoid exposing
storage-oriented fields or private harness metadata.

## Error ownership

Each deep module owns a small tagged error family.

```ts
type RepositoryError =
  | RepositoryNotFound
  | RevisionNotFound
  | SourceOutsideRepository
  | SnapshotUnavailable
  | RepositoryReadFailed

type KnowledgeError =
  | KnowledgeNotFound
  | KnowledgeConflict
  | InvalidPublication
  | ReviewOutdated
  | PersistenceFailed

type HarnessError =
  | HarnessUnavailable
  | HarnessPermissionDenied
  | HarnessTaskFailed
  | HarnessResultInvalid
  | HarnessRateLimited

type IntelligenceError =
  | RepositoryError
  | KnowledgeError
  | HarnessError
  | AnalysisBudgetExceeded
  | InvalidComponentPlan
  | InsufficientCoverage
```

`ApplicationServer` maps them into versioned `ApiError` values. Raw Git,
SQLite, Pi, provider, and HTTP errors do not cross their owning module.

## Ownership matrix

| Concern | Owner | Explicitly not owned by |
| --- | --- | --- |
| Git and filesystem | Repository Workspace | agents, UI, Knowledge Base |
| Snapshot identity | Repository Workspace | Pi, database schema |
| Anchor verification | Repository Workspace | model output |
| Components and interpretations | Knowledge Base | UI, harness |
| Freshness rules | Knowledge Base | model, UI |
| Recursive task graph | Intelligence Engine | planner agent, Pi |
| Prompt and context assembly | Intelligence Engine | UI |
| Model sessions and tools | Harness Runtime | domain modules |
| Human decisions | Knowledge Base | AI task |
| Client protocol and authentication | Application Server | domain modules |
| Presentation state | Web Client | Knowledge Base |

## Boundary invariants

1. An agent cannot publish knowledge directly.
2. An unverified path or range cannot become evidence.
3. A chat answer is not a durable interpretation until explicitly saved.
4. AI output cannot overwrite a user interpretation.
5. Freshness is computed relative to a snapshot and never treated as permanent.
6. A review cannot be promoted if its head snapshot changed.
7. A cancelled run cannot expose a partial wiki as complete.
8. Harness-specific types do not enter domain schemas.
9. SQLite-specific types and queries do not leave the Knowledge Base.
10. Adding an extension cannot weaken filesystem, permission, anchor, or
    publication invariants.

## Deliberately absent interfaces

The proposal intentionally does **not** define separate public services for:

- hashing;
- Git commands;
- files and hunks;
- components;
- interpretations;
- freshness scoring;
- prompts;
- routing;
- budgets;
- scheduling;
- Pi sessions;
- SQLite repositories per table.

Those are cohesive implementation details inside the deep modules. They should
be extracted only when independent use or replacement is demonstrated, not
because an interface can be written for them.
