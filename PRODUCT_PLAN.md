# Know the Map by Bleentr — Product Plan

> **Status:** Approved product direction and source of truth for product scope.
> Architecture and feature documents must be reconciled against this plan when
> they conflict.

## Product thesis

Know the Map is a **human-first repository and change intelligence system**. Its
job is to reduce the amount of system state a person must reconstruct when
reviewing unfamiliar or agent-generated code.

It does not treat generated prose as code truth. It preserves the relationship
between what can be observed in code and what humans or AI believe that code
means.

## Product kernel

The irreducible product is one loop:

1. Capture a reproducible code snapshot.
2. Recursively identify components until each leaf is a coherent unit that can be
   explored well.
3. Gather evidence at every component level, then explore every leaf—or record an
   explicit coverage gap—for the required detail.
4. Reconcile duplicate or overlapping components produced by independent agents
   without losing evidence or coverage.
5. Record a human or AI interpretation separately from that evidence.
6. Bind the interpretation to the exact evidence and code scope supporting it.
7. Detect when the supporting code changes.
8. Reduce the interpretation's freshness until it is revalidated.
9. Let a person inspect, correct, dismiss, accept, or supersede it.

```text
Code at snapshot A
  ↓ recursively divide into coherent components
Component exploration at every level
  ↓ capture facts across the repository
Component reconciliation
  ↓ merge duplicates and preserve shared references
Evidence
  ↓ explain what those facts mean
Interpretations bound to evidence
  ↓ code changes
Code at snapshot B
  ↓ compare supporting anchors
Freshness evaluation
  ↓
current · needs review · stale · orphaned
```

The central question is:

> What changed since this interpretation was created, and might it no longer
> hold?

If Know the Map can complete this loop reliably, it has a useful first product.

## Starting point and time

Know the Map begins at a user-selected baseline snapshot. It creates the initial
evidence and interpretations there, then tracks them forward as new snapshots
are reviewed.

It does not need to reconstruct a repository commit by commit from its origin.
Earlier history may be inspected on demand, but it is not a prerequisite for the
core loop.

## Product rules

### Evidence and interpretation remain distinct

Evidence is reproducible repository state: source, symbols, diagnostics, Git
changes, test results, and other tool output. Interpretations are claims about
responsibility, behavior, intent, risks, flows, or invariants.

Human notes may carry more authority than AI inferences, but both can become
stale when their supporting code changes. Confidence never turns an inference
into proof.

### Capabilities are loaded by intent

Component discovery, exploration and deduplication, evidence tracking, interpretation
binding, and freshness are always active.
Optional capabilities advertise a compact description and load their prompts,
tools, context, and tasks only when the user requests them or explicitly enables
them in a review policy.

A model cannot activate an expensive capability merely because it might produce
an interesting result. Cached results remain tied to their evidence snapshot and
do not automatically enable that capability later.

```text
always active
  component exploration → deduplication → evidence ↔ interpretation ↔ freshness

available on demand
  visual map · PR synthesis · Q&A · flow tracing · test gaps · review lenses
```

### Humans control durable knowledge

Agents propose knowledge; they do not publish truth directly. Important claims
remain traceable to evidence, uncertain links remain visibly uncertain, and user
decisions are preserved.

### Local-first and bounded

Repository access and stored knowledge remain local by default. Only selected
context is sent to a configured model provider. Filesystem access, tools, token
budgets, recursion, concurrency, and cancellation are bounded by the application.

### The harness is replaceable

Pi is the first embedded execution harness. Know the Map owns orchestration,
schemas, evidence validation, freshness, and publication; Pi owns each bounded
model session, its tools, provider selection, and streaming.

OpenCode and other harnesses may be added later. A direct model integration would
turn Know the Map into its own native harness and may enable tighter orchestration,
but that expansion is outside the MVP.

## Required MVP

The first product is one narrow end-to-end slice:

1. Open one repository at a reproducible baseline snapshot.
2. Recursively divide it into components until each leaf is coherent and bounded
   enough to explore.
3. Capture evidence belonging to parent components as well as detailed leaf evidence,
   and account for repository coverage.
4. Reconcile repeated or overlapping components without discarding their evidence.
5. Capture code evidence with stable, verifiable anchors.
6. Create human and AI interpretations bound to that evidence.
7. Change the code and identify affected interpretations.
8. Show why their freshness changed.
9. Let a person confirm, correct, dismiss, or supersede them.

A recursive component hierarchy is required because it is the exploration strategy.
A polished component-map UI, chat interface, semantic PR summary, flow analysis,
test-gap check, model router, or elaborate visualization is not required to validate
the loop.

## Candidate capabilities

Everything beyond the kernel is optional and demand-loaded. Current candidates
include:

- rich component maps and browsable briefs beyond the core exploration view;
- questions answered from progressively loaded repository knowledge;
- semantic base/head PR review;
- test protection and core-flow gap analysis;
- two-stage flow exploration: list flows first, trace only the selected flow;
- specialized performance, architecture, or security review lenses;
- stacked-PR feature trajectories and earlier-history exploration;
- richer Story, Map, and Code views.

Their behavior, activation rules, and prioritization are tracked in
[GitHub issue #22](https://github.com/nicolasLuduena/know-the-map/issues/22).
Appearing in that backlog does not make a capability part of the MVP.

## What to validate

Early use should answer:

- Can evidence anchors be reproduced and verified reliably?
- Do interpretations remain understandable when separated from evidence?
- Does freshness correctly identify knowledge that may no longer hold?
- Can a user understand why an interpretation lost freshness?
- Are user corrections preserved and given appropriate authority?
- Does the core loop improve understanding enough to justify its analysis cost?
- Which optional capability is actually needed next?

## Non-goals for the first slice

- AI approving code or replacing the human reviewer.
- Reconstructing the repository from its first commit.
- Sending the entire repository to a model by default.
- Running optional analyses without explicit activation.
- Supporting every language or coding harness.
- Building a replacement IDE.
- Treating generated prose or model confidence as proof.
- Implementing a full native agent runtime.

## Product framing

Know the Map should not optimize for the number of AI features it can run.

> **Optimize for preserving the relationship between code evidence and human
> understanding as the code changes.**

That is the source-of-truth principle for product and architecture decisions.

## Naming

- Product: **Know the Map by Bleentr**
- Short name: **Know the Map**
- Binary and command prefix: `ktm`

## Document map

- [Optional capability backlog](https://github.com/nicolasLuduena/know-the-map/issues/22)
- [Proposed architecture](./docs/architecture/PROPOSED_ARCHITECTURE.md)
- [Review UI options](./docs/design/UI_OPTIONS.md)
