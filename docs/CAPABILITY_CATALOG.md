# Know the Map — Candidate Capability Catalog

> **Status:** Optional product ideas. Nothing in this document is an MVP
> requirement merely because it is described here.

This document keeps possible applications of the evidence–interpretation kernel
out of the concise product plan. A capability should be implemented only when
there is evidence that users need it.

## Activation contract

Every optional capability declares:

- a short description suitable for a capability catalog;
- the user intent or explicit policy that activates it;
- required evidence and context;
- an estimated cost class;
- the structured result it produces;
- the anchors governing result freshness.

Descriptions may be visible without loading implementation instructions. Prompts,
tools, context, and analysis tasks are loaded only after activation. Models cannot
activate other capabilities autonomously.

Results may be cached by snapshot. A cached result remains inactive until requested
and becomes stale when its supporting evidence changes.

## Repository component map

### Purpose

Propose a navigable hierarchy of components, responsibilities, relationships, and
entry points for an unfamiliar repository.

### Activation

The user requests a repository map or enables it for the current workspace. Large
components may be recursively subdivided within explicit depth, task, token, and
concurrency budgets.

### Result

Compact component descriptors can be listed cheaply. Briefs and supporting code are
loaded progressively when a component is opened. Components are interpretations, not
permanent repository facts, and lose freshness with their anchors.

## Repository Q&A

### Purpose

Answer a question without placing the entire repository in one model context.

### Activation

The user's question activates Q&A. The system first routes through compact component
descriptors, then loads briefs, interpretations, and code only for likely components.

### Result

A cited answer with explicit evidence and uncertainty. Answers are not stored as
durable interpretations unless the user chooses to save them.

## Semantic PR review

### Purpose

Explain a change as a transition in understood behavior, structure, relationships, or
assumptions rather than as a collection of hunks.

### Activation

The user requests semantic review for a base and head snapshot or enables selected
review policies.

### Possible lenses

- intent and meaningful scope;
- structural or responsibility changes;
- behavioral changes and new cases;
- changed invariants and assumptions;
- blast radius across callers, consumers, tests, and public boundaries;
- concrete questions a person should resolve before approval.

Hunks remain evidence and navigation targets. They are not the organizing unit of the
review.

## Core-flow test gaps

### Purpose

Answer: **Which important user or system flow has no identified protecting test?**

### Activation

Disabled by default. It runs only when the user asks for test-gap analysis or enables
that check in an explicit review policy.

### Behavior

The system ranks relevant flows and connects tests to protected behavior using
deterministic evidence where possible. Failure to find a test is a possible coverage
gap, not proof that no test exists: indirect, generated, or external tests may be
invisible. Uncertain mappings remain interpretations.

This is behavioral coverage and does not replace line or branch coverage.

## On-demand flow explorer

### Purpose

Show the ordered operations and data transformations involved in a user or system flow,
including boundaries in a microservices repository.

### Activation and cost control

The capability is disabled by default and has two independent stages:

1. **Discover flows.** Opening Flow Explorer runs a bounded, relatively cheap pass and
   returns descriptors containing a name, trigger, outcome, likely components or
   services, assurance, and estimated trace cost.
2. **Trace one flow.** Selecting one descriptor runs the expensive analysis for that
   flow only.

If discovery recognizes 25 flows, the UI lists 25 descriptors. It does not schedule 25
detailed traces.

### Detailed result

The trace distinguishes:

- in-process function calls;
- HTTP or RPC requests;
- published and consumed events;
- queues and topics;
- database reads and writes;
- data transformations and state transitions;
- observed and inferred links.

Each step records the component or service, operation, input and output shapes, optional
redacted examples, state mutations, assurance, and evidence anchors.

```text
“User signs in”
POST /login
  → ApiGateway.forward(request)
      credentials → LoginCommand
  → HTTP: AuthService.authenticate(command)
      LoginCommand → authenticated User
  → RPC: TokenService.issue(user)
      User → signed access claims
  → SessionStore.save(session)
      no session → active session
  → publish UserLoggedIn
      Session → redacted audit event
```

The catalog and detailed traces are interpretations scoped to a snapshot. Changing an
anchored function, contract, message producer, consumer, or service relationship reduces
their freshness.

## Specialized review lenses

### Purpose

Ask questions appropriate to the actual risk of a selected change.

### Examples

- **Mechanical:** were references updated and behavior preserved?
- **Business logic:** which cases, fallbacks, ordering rules, or boundaries changed?
- **Architecture:** which responsibility moved, became asynchronous, or acquired new
  consistency requirements?
- **Security:** which trust boundary, validation path, authorization rule, or
  attacker-controlled input changed?

The user or review policy selects lenses. A classifier may recommend one but cannot run
an expensive lens without activation.

## Stacked PR trajectories

### Purpose

Explain how a sequence of PRs forms one feature, while preserving the approval boundary
of each PR.

### Possible questions

- Why was an abstraction introduced in an earlier PR?
- Which later PR consumes it?
- Does its eventual use match the design being approved?
- Was anything introduced but never used in the stack?
- Which early decisions constrain later changes?

This is later work. The core product starts at a selected baseline and tracks forward;
it does not require full repository-history reconstruction.

## Earlier-history exploration

### Purpose

Inspect selected history when a person asks why an interpretation or abstraction exists.

### Activation

The user selects an earlier range, commit, or question. The system does not walk from
the repository's origin by default.

## Presentation capabilities

Optional product surfaces may include:

- an editorial Story view for intent, risks, and questions;
- a Map view for component and flow relationships;
- a Code view for interpretations anchored to exact source;
- a PR-specific wiki combining overview, changes, flows, invariants, questions, and
  evidence;
- editor integrations consuming the same local application API.

The detailed alternatives and interaction states live in
[`design/UI_OPTIONS.md`](./design/UI_OPTIONS.md).

## Deferred native harness

A direct provider integration would make Know the Map responsible for the full agent
runtime. It could enable tighter orchestration, product-specific capabilities, and
potentially better results than a general-purpose harness, but it is outside the MVP.
The stable Harness Runtime boundary preserves that option.
