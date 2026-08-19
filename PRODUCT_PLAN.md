# What the Hunk? — Proposed Product Direction

> **Status:** Proposal for discussion. This document authorizes no
> implementation. The existing GitHub issues remain the active roadmap until
> this proposal is accepted and the issues are reconciled explicitly.

## The pivot

What the Hunk? (WTH) should be a local code-review service with interchangeable
clients.

The `wth` binary is the product core and source of truth. It owns:

- repository and workspace access;
- Git revisions, diffs, and stable hunk identity;
- language-server processes and semantic context;
- AI and agent-harness integrations;
- scheduling and cancellation;
- caching and persisted review state;
- annotations;
- invariants, evidence, and impact analysis.

The binary may also bundle and serve a Svelte/Monaco client locally. That is a
later delivery target, after the core interaction and protocol have been proven
through Neovim. It must require no account, hosted WTH backend, or source-code
transfer through WTH infrastructure.

The same service exposes a small, versioned, frontend-neutral protocol. A thin
Neovim plugin and future VS Code, Zed, CLI, or TUI clients render the same review
model without reimplementing repository access or analysis.

```text
                  ┌─ Neovim plugin (first)
wth local service ┼─ bundled Svelte/Monaco client (later)
                  ├─ future editor clients
                  └─ diagnostic CLI or TUI
```

The durable boundary is the local service, not a particular interface.

## Product thesis

WTH is a **hunk-centered code exploration and review tool**.

It is not a general-purpose AI editor. A review begins with a concrete diff and
uses each changed hunk as the root of a small semantic and impact graph:

```text
changed hunk
  ├─ enclosing symbols and types
  ├─ definitions
  ├─ direct callers and references
  ├─ relevant tests and diagnostics
  ├─ local invariants and evidence
  └─ potentially affected code
```

The user can move through the real codebase, load analysis for the visible
hunk, inspect how the code works, follow evidence, and return to the diff.
Analysis is lazy: opening a repository does not send every hunk to an AI
provider.

The architectural rule remains unchanged:

> Keep domain values and invariants stable; make integrations, policies, and
> behaviors customizable.

## Local-first experience

The eventual zero-setup entry point should be:

```sh
wth review main...HEAD
```

It resolves the repository and revisions, starts or attaches to the local
service, and creates a review workspace. `wth serve --no-open`, `wth status`,
and `wth stop` support editor clients and explicit lifecycle control. Semantic
and AI work begins only when requested.

The later bundled Svelte/Monaco client should provide:

- repository navigation with file contents loaded on demand;
- changed-file, hunk, diff, and source views;
- streamed explanations and follow-up questions;
- structured invariant and impact sections;
- evidence links that open the relevant file and range;
- annotations and viewed state;
- visible provider, context, permission, cache, stale, retry, and cancellation
  states.

The first browser client is a review workspace, not a replacement IDE. It may
navigate the entire codebase, but editing, formatting, terminals, debugging,
source-control operations, and extension compatibility are deferred.

All application assets must ship with the binary. The default experience must
not depend on a CDN, hosted font, telemetry endpoint, or WTH server.

## Naming

- Product: **What the Hunk?**
- Binary and command prefix: `wth`
- Protocol family: `wth/1`

Renaming is deferred until the workflow is validated. The architecture must not
encode the product name in domain concepts that should remain reusable.

## Authority and client sessions

The backend owns canonical review data:

- repository root and filesystem boundary;
- immutable base and head revisions;
- workspace materializations;
- normalized files and hunks;
- language-server and analyzer lifecycles;
- explanations, claims, findings, and impact graphs;
- shared annotations, viewed state, and question threads;
- cache identity and invalidation.

Clients own presentation and ephemeral state: cursor, selection, focus, scroll,
layout, temporary input, and client-specific keybindings.

Unsaved documents require client-scoped workspace views:

```text
Repository workspace
  ├─ canonical Git snapshot
  ├─ shared persisted review state
  └─ client sessions
       ├─ browser workspace view
       └─ Neovim workspace view + document overlays
```

Once submitted, the service validates and owns an overlay within that client
session. Overlays are never global mutable state: two clients may have different
unsaved versions of the same file. Snapshot and cache identity therefore
include the canonical revision plus the requesting session's sorted overlay
content hashes.

When relevant content changes, analysis for the old view is cancelled and its
results become stale. No AI request restarts automatically.

The headless `ReviewEngine` remains stateless at its use-case boundary. The
local service is intentionally stateful at the composition root because it owns
scoped processes, connections, stores, and client sessions.

## Frontend-neutral protocol

WTH should define one versioned message schema with transport adapters:

- WebSocket for the bundled browser client;
- stdio for Neovim and command-line integrations;
- an attachable local socket may be added later.

Transports must not develop separate semantics. The protocol exposes review
concepts, not UI widgets:

```text
workspace and document access
diff and hunk navigation
streamed explanation and follow-up
invariants, impact, and evidence
annotations and viewed state
cancellation and shutdown
```

It must preserve schema validation, protocol and capability versions,
structured errors, stable stream identities, backpressure, content-addressed
snapshots, and cancellation mapped to Effect interruption.

Clients receive structured values such as `InvariantClaim`, `ImpactGraph`, and
`EvidenceLocation`; each client chooses its own rendering.

## Repository and semantic context

The service must not send the entire repository to each client or analyzer.
File-tree operations return metadata, clients load contents and ranges on
demand, and the context planner supplies bounded excerpts to semantic and AI
providers. Large files, binaries, generated files, and ignored paths require
explicit policy.

The local service owns language-server processes so every client sees the same
semantic model and thin clients do not normalize raw LSP responses.

Servers start lazily for an approved workspace, synchronize canonical documents
and overlays, forward cancellation, and end with their Effect scope. Conflicting
client overlays must not share mutable LSP document state; a server may be
reused only when the workspace view identity is identical.

The frontend protocol receives normalized semantic evidence:

- enclosing symbols and hover information;
- definitions and type definitions;
- references and call relationships;
- diagnostics;
- concise excerpts around returned locations.

## AI and privacy boundary

Source code must never pass through WTH-operated infrastructure in the
local-first product.

A configured remote AI provider may still receive selected context. The UI must
show which runner is active, whether it is local or remote, which categories of
context are selected, and which tools or permissions are available.

Agent integrations remain replaceable `AgentRunner` capabilities. Local models
and harnesses use the same client protocol and domain values.

## Invariants, evidence, and impact

Important claims should be structured and navigable rather than only prose or
an opaque confidence score.

```text
[OBSERVED] arr.length <= 10
  schema guard · src/input.ts:18

[INFERRED] 0 <= a <= 10
  from conditions at src/input.ts:18 and src/parser.ts:31-34

[UNVERIFIED] callers may pass a negative offset
  analyzer hypothesis
```

Every claim carries a stable identity, expression, relevant variables, source
scope, assurance level, evidence locations, and short derivation.

| Level | Meaning |
| --- | --- |
| `proven` | Machine-checked by an identified verifier with reproducible evidence. |
| `observed` | Directly present in source, types, diagnostics, guards, assertions, or schemas. |
| `inferred` | Derived from supporting evidence but not machine-proven. |
| `unverified` | Analyzer hypothesis without sufficient supporting evidence. |

The first language-specific path targets TypeScript. Version one must not emit
`proven`; that label remains reserved until a real verifier exists.

Impact analysis is an evidence graph rooted at a changed hunk. Nodes may include
symbols, callers, tests, diagnostics, invariants, and public boundaries. Edges
record why nodes are related, their provider, and source locations. Model
hypotheses remain distinguishable from LSP, syntax, Git, and test evidence.

## Local service security

Localhost is a security boundary, not a trust guarantee. The service must:

- bind only to loopback by default and authenticate every client;
- validate browser origins and never use wildcard CORS;
- apply a restrictive Content Security Policy;
- restrict access to explicitly opened workspace roots;
- resolve symlinks and reject traversal or arbitrary file URIs;
- require permission before starting tools or language servers;
- disable telemetry by default;
- require deliberate authentication and transport security for remote binding.

Review state and caches use scoped local storage with migrations and clear
ownership. One repository service coordinates concurrent clients.

## Client strategy

### First client: Neovim

Neovim is the first validation surface. Its users already have code navigation,
buffers, splits, and established review habits, so a small plugin can test the
actual WTH interaction without first building another editor.

The plugin stays thin. It uses normal buffers, extmarks, virtual lines,
highlights, location lists, splits, and floats. Git parsing, LSP processes,
caching, prompts, and analysis remain in the service.

### Later client: bundled web application

After the protocol and interaction are stable, Svelte/Monaco becomes the
zero-setup browser experience and the most complete client. It should consume
the same review values instead of defining a separate application model.

### Future clients

- VS Code should prefer native editor surfaces.
- Zed is a target, not a promise; it depends on the extension API supporting the
  required UI and process communication.
- A CLI or TUI may serve diagnostics and automation, not the primary experience.

Compatibility means one shared domain and protocol with client-specific
transports and rendering. It does not mean identical interfaces.

## First vertical slice

Build only enough to validate the hunk-review loop:

```text
wth local service
  -> resolve Git diff
  -> expose normalized hunks over stdio
  -> Neovim marks hunks
  -> [h and ]h navigate
  -> explain hunk at cursor
  -> stream answer into a split
  -> cancel when the buffer changes
```

Initial commands:

- `:WthStart [base]`
- `:WthExplain`
- `:WthNext`
- `:WthPrev`
- `:WthStop`

Then add, in order: evidence jumps, follow-up questions, service-owned language
servers, invariants, impact analysis, and annotations or persisted review state.

## Proposed milestones

These milestones describe sequencing, not implementation authorized by this
document.

1. **Accept and reconcile the plan.** Confirm the local service and Neovim-first
   validation strategy; then update architecture documents and issues.
2. **Establish the minimum service boundary.** Define the `wth/1` values needed
   for the first slice, stdio transport, stream identity, and cancellation while
   preserving a clean path to WebSocket and client sessions.
3. **Validate the Neovim loop.** Mark and navigate hunks, explain the hunk at the
   cursor, stream into a split, and cancel analysis when the buffer changes.
4. **Make explanations navigable.** Add evidence jumps, follow-up questions, and
   service-owned language-server context.
5. **Deepen review semantics.** Add TypeScript invariants, evidence-backed impact
   graphs, annotations, and persisted review state.
6. **Build the bundled browser client.** Add the Svelte/Monaco zero-setup
   experience over WebSocket using the already validated protocol.
7. **Consider other clients** only after the protocol and workflow are stable.

## Proposed issue migration

No issue is changed by this branch. If the proposal is accepted:

| Issue | Proposed disposition |
| --- | --- |
| #1–#6 | Close after the production-foundation PR merges; create focused follow-ups for new domain, protocol, session, and overlay work. |
| #7 | Keep as the first real OpenCode `AgentRunner` milestone. |
| #8 | Split completed cache work from review state, annotations, and migrations. |
| #9 | Replace first with the minimal Neovim client; track the bundled web client as a later milestone. |
| #10 | Rewrite around binary → Neovim end-to-end first, then binary → web. |
| #11 | Rewrite around service-owned language servers and workspace-view isolation. |
| #12 | Keep deferred; workspace materialization and isolation remain prerequisites. |
| #13 | Keep deferred. |

## Non-goals for the first product slice

- A hosted WTH backend.
- Sending repositories through WTH infrastructure.
- A bundled browser application in the first validation slice.
- Turning Monaco into a full replacement IDE.
- Editing, terminals, debugging, formatters, or source-control actions in the
  first browser client.
- Whole-codebase chat detached from a diff.
- Every editor or language immediately.
- Presenting model confidence as proof.
- Silent downloads, telemetry, hidden execution, or remote binding.

## Decision record

This proposal chooses the local `wth` binary as the authoritative backend,
Neovim as the first implemented client, Svelte/Monaco as a later bundled client,
one versioned frontend-neutral protocol, backend-owned Git/LSP/analysis/state,
client-scoped overlays, lazy loading, TypeScript-first invariants, evidence
tiers, and local-only authenticated operation.

## References

- [Current architecture](./what-the-hunk-architecture.md)
- [Current condensed overview and MVP](./what-the-hunk-overview.md)
- [Monaco Editor](https://github.com/microsoft/monaco-editor)
- [Neovim API](https://neovim.io/doc/user/api)
- [Visual Studio Code Extension API](https://code.visualstudio.com/api/)
- [Zed extensions](https://zed.dev/docs/extensions)
