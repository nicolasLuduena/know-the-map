# Know the Map product plan

> **Status:** Approved product direction and source of truth for product scope.
> Architecture and feature documents must be reconciled against this plan when
> they conflict.

## Product thesis

Know the Map is a **local, private, version-exact index of the code a project
depends on**. Agents read it over MCP, and every claim carries anchors to the
source lines that support it.

DeepWiki is the reference point. It is useful, but it covers public
repositories only, returns prose, and has no version pinning. Context7 reads
documentation, so it is only as right as the documentation. Neither works for
private or internal packages, and neither lets an agent verify a claim against
the lines behind it.

Know the Map does not treat generated prose as code truth. It preserves the
relationship between what can be observed in code and what the index believes
that code means, and it lets the reader check one against the other.

## Product kernel

The irreducible product is one loop:

1. Snapshot a directory.
2. Recursively divide it into components until each leaf is a coherent unit
   that can be explored well.
3. Gather evidence with line anchors at every component level, then explore
   every leaf, or record an explicit coverage gap.
4. Reconcile duplicate or overlapping components produced by independent
   sessions without losing evidence or coverage.
5. Bind each interpretation to the exact evidence and code scope supporting it.
6. Validate every claim against the files it cites.

```text
Directory at a source hash
  ↓ recursively divide into coherent components
Component exploration at every level
  ↓ capture facts with line anchors
Component reconciliation
  ↓ merge duplicates and preserve shared references
Evidence
  ↓ explain what those facts mean
Interpretations bound to evidence
  ↓ check every claim against the cited lines
Validated, anchored index
```

The central question is:

> What does this package do, and which lines prove it?

If Know the Map can complete this loop reliably on a whole package, it has a
useful first product.

## Starting point and time

Know the Map indexes a dependency at a pinned version. Any directory at a
source hash qualifies, which covers packages from a public registry, private
packages, packages internal to a monorepo, and vendored forks.

A published version never changes, so freshness collapses to "which version".
The index does not track a repository forward through time, and it does not
need earlier history of the package.

The subject of the first slice is the user's dependencies, not the user's own
repository. Indexing the user's own code over time is the same mechanism applied
to a different subject and is deferred, not deleted.

## Product rules

### Evidence and interpretation remain distinct

Evidence is reproducible source state: files, symbols, and line ranges at a
known hash. Interpretations are claims about responsibility, behavior, intent,
risks, flows, or invariants.

Every interpretation cites anchors, and validation rejects a claim that does
not match the source. Confidence never turns an inference into proof.

### Local and private by default

The index is built and stored on the user's machine. Analysis runs through the
user's own provider keys. Only the files of the package being indexed are sent
to the model, and nothing else leaves the machine.

### Local-first and bounded

Filesystem access, tools, token budgets, recursion, concurrency, and
cancellation are bounded by the application. A model cannot widen its own
scope.

### Sharing is opt-in and later

Sharing analyses is opt-in per package and not part of the first slice. The
artifact identity in [#58](https://github.com/nicolasLuduena/know-the-map/issues/58)
must still be designed so that a downloaded artifact for a public dependency
can replace a local run later.

### Cheap models are the target

Indexing must be affordable enough to run on every dependency a project cares
about. The smoke test on 2026-09-19 used `opencode-go/deepseek-v4.1-flash` at
$0.15 per million input tokens and $0.60 per million output tokens, on
`effect@4.0.0-rc.112` `src/unstable/cli`, 25 files and 672 KB. It took 335
seconds and 22 calls, with 0 clarification rounds and 0 gaps, and produced 186
anchored interpretations. The root division matched the package's real
structure, and 3 of 3 sampled claims were correct when checked against the
source.

### The harness is replaceable

OpenCode is the first embedded execution harness. Know the Map owns
orchestration, schemas, evidence validation, and the artifact; OpenCode owns
each bounded model session, its tools, provider selection, and streaming.

Pi and other harnesses may be added later. A direct model integration would
turn Know the Map into its own native harness and may enable tighter
orchestration, but that expansion is outside the MVP.

## Required MVP

The first product is one narrow end-to-end slice:

1. Index one package at one version from its source directory, producing an
   artifact keyed by package identity.
2. Serve that artifact over MCP. An agent can find components, read a
   component with its interpretations, and read the source lines behind an
   anchor.
3. Use it daily. Run Claude Code on this repository with `effect` indexed and
   compare against reading `node_modules/effect` directly.

A recursive component hierarchy is required because it is the exploration
strategy, and a whole library does not fit through one session, which is why
[#48](https://github.com/nicolasLuduena/know-the-map/issues/48) was the first
build step. A viewer, chat interface, semantic PR summary, flow analysis,
test-gap check, model router, or hosted registry is not required to validate
the loop.

## Deferred capabilities

Everything beyond the kernel is deferred. Current candidates include:

- index your own repository too: human-written interpretations, the viewer,
  freshness across snapshots, and a person confirming or dismissing
  interpretations whose supporting code changed;
- questions answered from progressively loaded package knowledge;
- specialized performance, architecture, or security review lenses.

Their prioritization is tracked under
[#60](https://github.com/nicolasLuduena/know-the-map/issues/60). Appearing
there does not make a capability part of the MVP.

## What to validate

Early use should answer:

- Does a cheap model index a full package, not a subpackage, within an
  acceptable cost and time?
- Does an agent with the server attached use less context on a real task than
  one without?
- Does anchored evidence get used? That is, does the agent call `read_anchor`,
  and does it catch a wrong claim when one exists?

## Non-goals for the first slice

- A hosted registry or any sharing of artifacts.
- Human-written interpretations, the viewer, and freshness across snapshots.
- Indexing every dependency automatically. The user names the package.
- Letting a model orchestrate the split.

## Product framing

Know the Map should not optimize for the number of AI features it can run.

> **Optimize for giving an agent a verifiable answer about a dependency at the
> exact version the project uses.**

That is the source-of-truth principle for product and architecture decisions.

## Naming

- Product: **Know the Map**
- Short name: **Know the Map**
- Binary and command prefix: `ktm`

## Document map

- [Artifact identity by package](https://github.com/nicolasLuduena/know-the-map/issues/58)
- [Serve an artifact over MCP](https://github.com/nicolasLuduena/know-the-map/issues/59)
- [Backlog re-triage](https://github.com/nicolasLuduena/know-the-map/issues/60)

### Deferred

- [Review UI options](./docs/design/UI_OPTIONS.md)
