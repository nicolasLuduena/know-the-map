# Know the Map by Bleentr — Repository & Change Intelligence

> **Status:** Approved product direction and source of truth for future product planning.
> This document defines the product thesis. Existing architecture and roadmap issues
> should be reconciled against it explicitly rather than treated as authoritative
> where they conflict.

## Product thesis

Know the Map should be a **human-first repository and change intelligence system**.

The product is not primarily an AI reviewer and it is no longer centered on individual
hunks as the top-level abstraction. Its job is to reduce the amount of system state a
human reviewer must reconstruct mentally when reviewing large, unfamiliar, or
agent-generated changes.

A DeepWiki-like repository view is one surface over a persistent repository model. PR
review consumes that model to explain a transition:

> What was this system, what does this change alter, what does it become, and what
> should a human verify before approving it?

The product succeeds when a reviewer can understand a change as a set of navigable
architectural and behavioral decisions, trace claims back to code evidence, and know
which questions remain unanswered.

## Product model

Know the Map has three primary layers:

1. **Harness / execution** — how analysis is performed and who pays for inference.
2. **Repository intelligence** — a persistent structural and semantic model of the codebase.
3. **Change intelligence** — a temporal, semantic model of how a PR or stack transforms the repository.

PR review is the interaction built on top of these layers.

```text
                 Repository intelligence
                 "What is this system?"
                          │
                          ▼
                    Temporal model
                "How did it get here?"
                          │
                          ▼
                    Change analysis
               "What does this alter?"
                          │
                          ▼
                       Review
                "Should I approve it?"
```

## Harness / execution layer

The harness is a first-class replaceable capability. Know the Map should not
require users to buy inference from Bleentr for every model invocation.

Users should be able to reuse an existing coding-agent subscription, local model, or
provider account through interchangeable runners such as:

```text
Know the Map
 ├─ OpenCode
 ├─ Codex
 ├─ Claude Code
 ├─ local / self-hosted model
 └─ direct model API
```

This separates product economics from inference economics. A small fixed subscription
can pay for the product experience — indexing, history, storage, review workflow,
collaboration, and UI — while users bring the execution environment that fits their
privacy and cost requirements.

The durable abstraction is a harness capability, not a specific provider SDK.
Different harnesses may expose different capabilities, permissions, context limits,
streaming semantics, or tools; Know the Map should normalize those differences behind
a common review-task boundary where practical.

Direct API integration remains useful, but it should be an adapter rather than the
architectural center.

## Repository intelligence

Know the Map maintains a structured representation of the repository. Generated prose
is useful, but prose is not the source of truth.

The repository model should include, as available:

- modules, files, symbols, types, and public interfaces;
- imports and dependency relationships;
- definitions, references, callers, and callees;
- control and data-flow relationships where they can be derived reliably;
- entry points and important abstractions;
- tests and the behavior they protect;
- architectural boundaries;
- diagnostics;
- known invariants and assumptions;
- importance or ranking information derived from repository structure.

This model should be assembled from deterministic evidence first: Git, ASTs, language
servers, static analysis, build metadata, tests, and other analyzers. Models add semantic
interpretation where deterministic tools cannot answer the question economically or
reliably.

The UI may present this model as a DeepWiki-like navigable repository:

```text
Repository
 ├─ concepts
 ├─ modules
 ├─ architecture
 ├─ flows
 ├─ important abstractions
 ├─ invariants
 └─ code evidence
```

Every generated explanation should remain traceable to concrete repository evidence.

## The temporal repository model

A conventional repository wiki answers what the repository is now. Know the Map must
also model how it changes over time.

Git already provides immutable repository states. Know the Map should derive semantic state by
commit and preserve enough structure to compare states efficiently.

```text
commit A
  └─ repository graph v18

commit B
  └─ delta
       + SessionStore
       AuthService -> SessionStore
       - AuthService -> Database

commit C
  └─ delta
       SessionStore.persist() semantics changed
```

The resulting knowledge model has two dimensions:

```text
                 Repository knowledge graph
                           │
               ┌───────────┴───────────┐
               │                       │
            structure                history
               │                       │
       symbols / calls / concepts    A -> B -> C
```

Know the Map does not need to regenerate an entire repository wiki for every revision. It should
prefer content-addressed structural state plus incremental semantic deltas where
possible.

History enables questions that current-state code search cannot answer well:

- Why does this abstraction exist?
- Which PR introduced this invariant?
- When did this module become significantly more complex?
- Which recent abstractions still have no consumers?
- Which architectural boundary changed most during a feature?
- Which code still assumes the execution model that existed before this PR?

## Change intelligence

A PR is a semantic transition between two repository states, not merely a text diff.

For a base revision and head revision, Know the Map should construct and compare repository
models, then explain the meaningful delta.

```text
                  main @ A
                     │
                     │ PR
                     ▼
                  head @ B

          semantic repository diff
                     │
       ┌─────────────┼─────────────┐
       │             │             │
   structure      behavior     invariants
       │             │             │
       └─────────────┼─────────────┘
                     ▼
                review lenses
```

For a change, the system should answer:

### Intent

What capability, behavior, or architectural decision is being introduced?

### Structural impact

Which modules, symbols, dependencies, interfaces, or flows were introduced, removed,
rerouted, or reinterpreted?

### Behavioral impact

What previously true behavior is no longer true? What new cases exist?

### Invariant impact

Which assumptions were added, removed, or changed? Which values must now remain
consistent, ordered, synchronized, idempotent, or eventually consistent?

### Blast radius

Which callers, consumers, tests, public boundaries, or later changes depend on this
transition?

### Review questions

What does a human actually need to decide or verify before approving the change?

The output should avoid shallow descriptions. For example, instead of:

> `SessionStore` stores sessions.

Prefer:

> Session state was previously derived directly from the database. This change
> introduces `SessionStore` as an intermediate abstraction. Persistence and invalidation
> must now remain consistent. Review what happens if persistence succeeds but cache
> invalidation fails.

## The PR-specific wiki

The primary review surface can be understood as a temporary wiki whose subject is the
change.

A PR workspace may expose:

```text
Overview
Architecture
Changes
Flows
Invariants
Risks
Questions
Code
```

### Overview

Intent, scope, important files, major concepts, and a map of the transition.

### Architecture

A semantic before/after representation of important boundaries and relationships.

### Changes

Concepts, abstractions, interfaces, and behaviors introduced, removed, or modified.

### Flows

Control or data flows affected by the change, with links to evidence.

### Invariants

Structured assumptions that changed or must continue to hold.

### Questions

Review lenses chosen specifically for the type of change.

### Code

The exact files, symbols, hunks, definitions, references, tests, and diagnostics that
support each claim.

Hunks remain important evidence and navigation units, but they are primitives inside the
change model rather than the product's organizing principle.

## Review strategy and model routing

Different changes deserve different questions and different levels of model capability.
The central abstraction is therefore **review-strategy routing**, not just model routing.

```text
change
  ↓
classification
  ↓
review strategy
  ↓
context selection
  ↓
model / harness selection
  ↓
human navigation
```

### Trivial or mechanical changes

Use a fast, inexpensive model when one is needed.

Questions may include:

- Is behavior unchanged?
- Were all references updated?
- Did a public API name change?
- Is this purely generated or formatting noise?

### Business logic changes

Use stronger semantic analysis.

Questions may include:

- Which cases changed?
- Which old assumptions are no longer valid?
- Are boundary, rounding, ordering, or fallback cases affected?
- Which callers rely on the previous behavior?

### Architectural changes

Use repository graph, LSP/static evidence, and a stronger model.

Questions may include:

- Which responsibility moved?
- Which architectural boundary changed?
- What became asynchronous or eventually consistent?
- Which ordering guarantees disappeared?
- Where are retries, cancellation, idempotency, or recovery handled?
- Which downstream code still assumes the old architecture?

### Security or critical changes

Use the strongest appropriate strategy and specialized passes.

Questions may include:

- Which trust boundaries changed?
- What new input is attacker-controlled?
- Which authorization or validation invariant changed?
- Is a previously mandatory validation path bypassable?

The same PR can contain regions belonging to different strategies.

## Stacked PRs and feature trajectories

Stacked agent-generated PRs are a first-class use case.

A foundational PR often introduces types, interfaces, or abstractions whose purpose is
visible only in later PRs. Reviewing each PR as an isolated diff forces the human to
mentally predict the future stack.

Know the Map should understand a stack as a **feature trajectory** while preserving the review
boundary of each individual PR.

```text
Feature X

PR #40  Foundation
         ├─ SymbolGraph   -> used #41, #43
         ├─ IndexContext  -> used #42
         └─ GraphCache    -> unused in stack ⚠

PR #41  Indexing
PR #42  Analysis
PR #43  UI integration
```

The reviewer should be able to ask:

- Why is this abstraction introduced here?
- Which later PR consumes it?
- Does its eventual use match the abstraction being approved now?
- Is anything introduced in the stack never used?
- Which design decisions in PR 1 constrain PRs 2–4?

This turns stacked review from isolated diff reading into review of a coherent feature
trajectory.

## Evidence, invariants, and confidence

Important claims should be structured and navigable rather than hidden inside generated
prose or represented as opaque confidence scores.

```text
[OBSERVED] arr.length <= 10
  schema guard · src/input.ts:18

[INFERRED] callers rely on synchronous completion
  call sites · src/service.ts:40-81

[UNVERIFIED] retry ordering may duplicate writes
  analyzer hypothesis
```

Useful assurance levels include:

| Level | Meaning |
| --- | --- |
| `proven` | Machine-checked by an identified verifier with reproducible evidence. |
| `observed` | Directly present in code, types, diagnostics, guards, schemas, tests, or tool output. |
| `inferred` | Derived from supporting evidence but not machine-proven. |
| `unverified` | Analyzer hypothesis without sufficient supporting evidence. |

Models must not silently upgrade hypotheses into facts. Every important claim should link
back to its evidence and indicate how it was obtained.

## Local-first privacy and security

Know the Map should remain local-first even if the eventual product includes paid
hosted services. Source code should not need to pass through Bleentr-operated
infrastructure for core review.

The local service may own:

- repository and workspace access;
- Git revisions and semantic state;
- AST and language-server processes;
- local repository graph construction;
- scheduling and cancellation;
- caches and persisted review state;
- harness integrations;
- evidence and impact analysis.

A configured remote harness or provider may receive selected context according to the
user's own configuration. The UI must make the active runner, remote/local boundary,
selected context, tools, and permissions visible.

Localhost is still a security boundary. Any browser-facing local service must bind to
loopback by default, authenticate clients, validate origins, restrict filesystem roots,
resolve symlinks safely, reject traversal, and require deliberate configuration before
remote binding.

## Client and UI strategy

The product model is frontend-neutral, but the most expressive product surface is likely
a local web application because the repository/change graph requires navigation beyond a
traditional diff.

The web UI should provide a DeepWiki-like exploration experience with code-aware links,
semantic before/after views, review questions, evidence, and review state.

Editor integrations such as Neovim, VS Code, or Zed can remain valuable companion
clients. They should consume the same repository and change model rather than define a
separate product architecture.

The durable boundary is therefore the repository/change intelligence service and its
domain model, not Monaco, Neovim, a TUI, or any particular harness.

## Near-term MVP

The first implementation should validate semantic change review before attempting the
complete long-term product.

1. **One repository, one PR.** Resolve a base and head commit reliably.
2. **Persistent structural graph.** Build useful repository structure from Git plus
   TypeScript AST/LSP evidence.
3. **Two semantic states.** Represent the base and PR head as repository states.
4. **Semantic delta.** Identify changed symbols, relationships, boundaries, and flows.
5. **Change classification.** Distinguish trivial, behavioral, architectural, and
   critical areas.
6. **Targeted questions.** Generate review questions appropriate to each change type.
7. **Harness routing.** Use a fast/cheap model for simple work and a stronger model for
   complex analysis, behind an explicit harness abstraction.
8. **DeepWiki-like review UI.** Navigate overview, architecture, changes, questions,
   evidence, and exact code.
9. **Traceability.** Every important generated claim links back to deterministic evidence
   or is labeled as inference/hypothesis.
10. **Stack awareness later.** Add multi-PR feature trajectories only after single-PR
    semantic transitions are genuinely useful.

The MVP should optimize for learning whether this representation makes a human materially
faster and more confident at reviewing code — not for feature completeness.

## Product questions to validate

Early usage should answer:

- Does the generated decomposition match the reviewer's mental model of a familiar repo?
- Does semantic before/after reduce time spent reconstructing architecture manually?
- Are generated review questions useful or mostly noise?
- Which repository facts must be deterministic rather than model-generated?
- How much analysis can be reused across commits?
- Does harness-based execution make cost and privacy meaningfully easier for users?
- Does the UI remain useful on small PRs without overwhelming the reviewer?
- Do stacked PR trajectories solve a real pain that ordinary PR tooling does not?

## Non-goals for the first product slice

- AI autonomously approving or replacing the human reviewer.
- Sending an entire repository to a model by default.
- Building a replacement IDE.
- Supporting every language immediately.
- Supporting every coding harness immediately.
- A full historical architecture explorer before single-PR review works.
- Treating generated prose as repository truth.
- Presenting model confidence as proof.
- Performing expensive analysis when deterministic tooling can answer the question.

## Product framing

Know the Map consists of two tightly connected capabilities:

**Repository intelligence**

> What is this system, and how did it get here?

**Change intelligence**

> What does this PR alter, and should I approve the transition?

Change intelligence consumes repository intelligence. The harness abstraction cuts
across both.

The product should not optimize for AI replacing the reviewer.

> **Optimize for reducing the amount of system state the reviewer must reconstruct
> mentally.**

That is the source-of-truth principle for future product and architecture decisions.

## Naming

- Product: **Know the Map by Bleentr**
- Short name: **Know the Map**
- Binary and command prefix: `ktm`

The name can be revisited later. Architecture and domain concepts should not depend on it.

## References

- [Proposed local wiki architecture](./docs/architecture/PROPOSED_ARCHITECTURE.md)
- [Component interaction traces](./docs/architecture/INTERACTION_TRACES.md)
- [Interfaces and module ownership](./docs/architecture/INTERFACES.md)
- [Review UI options](./docs/design/UI_OPTIONS.md)
