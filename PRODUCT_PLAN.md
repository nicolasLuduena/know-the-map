# What the Hunk? — Proposed Product Direction

> **Status:** Proposal for discussion. This document changes no implementation
> commitment by itself. The existing GitHub issues remain the active roadmap
> until this proposal is accepted and the issues are reconciled explicitly.

## The pivot

What the Hunk? should remain a headless, stateless diff-analysis engine, but a
standalone terminal UI should no longer define the primary product experience.

The useful workflow already happens inside an editor:

```text
move through real code
  → land on a changed region
  → ask what changed and why
  → follow definitions, callers, tests, and diagnostics
  → inspect claims about program state
  → return to the hunk
```

Recreating buffers, code navigation, syntax awareness, search, references, and
language-server interaction inside a TUI would turn WTH into a partial editor.
The proposed first client is therefore a Neovim plugin. The engine stays
client-independent so VS Code, a web client, or a small diagnostic CLI can be
added later without changing the domain or analysis model.

## Product thesis

WTH is a **hunk-centered code exploration tool**.

It is not a general-purpose AI editor. A review begins with a concrete diff and
uses the changed hunk as the root of a small semantic graph:

```text
changed hunk
  ├─ enclosing symbol and types
  ├─ definitions
  ├─ direct callers and references
  ├─ relevant tests
  ├─ diagnostics
  └─ evidence about local invariants
```

The user should be able to move through that graph using normal editor
navigation, request analysis at the cursor, and jump from every important claim
to supporting code.

The architectural rule remains unchanged:

> Keep domain values and invariants stable; make integrations, policies, and
> behaviors customizable.

## Proposed user experience

The first product client should support this loop:

1. Start a review for a base and head revision.
2. Show changed hunks in ordinary Neovim buffers using signs or extmarks.
3. Move to the next or previous hunk across files.
4. Explain the hunk at the cursor in a native split or temporary preview.
5. Stream the explanation without blocking editor navigation.
6. Inspect definitions, callers, tests, diagnostics, and invariant evidence.
7. Jump directly from a claim to its source evidence.
8. Ask a follow-up question using the current hunk and prior conversation.
9. Cancel obsolete work when the user edits the buffer or navigates away.

The plugin should use native Neovim surfaces: buffers, splits, floats, location
lists, `vim.ui.input`, LSP clients, and Tree-sitter. It should not embed a second
editor or introduce a permanent chat dashboard.

Default mappings, if enabled, should be buffer-local and active only during a
WTH review. Every mapping must be configurable or removable.

## Proposed client boundary

Neovim cannot consume the in-process TypeScript API directly. The proposed
client boundary is a local WTH daemon using versioned JSON-RPC over stdio:

```text
Neovim plugin (Lua)
  ├─ buffers and navigation
  ├─ live document contents
  ├─ attached LSP results
  └─ rendering and interaction

           JSON-RPC / stdio

WTH daemon (TypeScript + Effect)
  ├─ ReviewApi
  ├─ engine and scheduler
  ├─ plugin registry
  ├─ Git diff source
  ├─ analyzers and agent runners
  └─ cache and persistence capabilities
```

One daemon should be scoped to one editor workspace and exit when its stdio
connection closes. Effect interruption remains the authoritative cancellation
mechanism.

The plugin should require an explicit `wth` executable on `PATH`, or a configured
command. WTH must not silently download or execute binaries, language servers,
or models.

## Live editor state

The visible buffer is the source of truth for the editor experience, including
unsaved changes.

For each request, Neovim should provide the content and version of every loaded,
modified buffer inside the repository. WTH should derive an ephemeral,
content-addressed workspace identity from the reviewed Git revision and sorted
overlay content hashes.

Consequences:

- Unsaved code can be analyzed without forcing a save.
- Results become stale immediately after a relevant buffer changes.
- Active analysis is cancelled when its input changes.
- No model request restarts automatically; the user explicitly asks again.
- Cache entries for different overlay contents cannot collide.
- Files outside the workspace root are rejected unless a future permission
  policy explicitly allows them.

## Semantic context

The first client should reuse Neovim's attached language-server clients rather
than starting a duplicate server inside WTH.

Neovim should normalize supported LSP results into validated context fragments:

- enclosing symbol and hover information;
- definitions and type definitions;
- references;
- incoming and outgoing calls when supported;
- diagnostics;
- concise excerpts around returned locations.

The engine remains responsible for validation, deduplication, ordering, and
budgets. Editor-provided context is untrusted input at the API boundary.

Daemon-managed language servers remain a valid future capability for headless,
web, and remote clients. They are not required for the Neovim-first validation
slice.

## Invariants and evidence

WTH should represent important claims as structured, navigable data rather than
only prose or an opaque confidence score.

Example:

```text
[OBSERVED] arr.length <= 10
  schema guard · src/input.ts:18

[INFERRED] 0 <= a <= 10
  from conditions at src/input.ts:18 and src/parser.ts:31-34

[UNVERIFIED] callers may pass a negative offset
  analyzer hypothesis
```

Every invariant claim should carry:

- a stable identity;
- the expression being claimed;
- the relevant variables;
- its source scope;
- an assurance level;
- one or more evidence locations;
- a short explanation of how the evidence supports the claim.

The assurance levels have strict meanings:

| Level | Meaning |
| --- | --- |
| `proven` | Machine-checked by an identified verifier with reproducible evidence. |
| `observed` | Directly present in source, types, diagnostics, guards, assertions, or schemas. |
| `inferred` | Derived from supporting evidence but not machine-proven. |
| `unverified` | Analyzer hypothesis without sufficient supporting evidence. |

The first language-specific path should target TypeScript. It may extract
comparisons and conjunctions from guards, loop conditions, assertions, type
predicates, assignments, and validation schemas. Version one must not emit
`proven`; that label remains reserved until a real verifier exists.

## Proposed milestones

These milestones describe sequencing, not work authorized by this document.

### 0. Accept and reconcile the plan

- Review this proposal.
- Decide whether Neovim replaces the TUI as the MVP client.
- Update the architecture and condensed overview only after acceptance.
- Reconcile GitHub issues explicitly rather than leaving two roadmaps.

### 1. Establish the editor-neutral boundary

- Define versioned transport schemas.
- Add a scoped local daemon over JSON-RPC/stdio.
- Preserve streaming, structured errors, and Effect cancellation.
- Add live document overlays to snapshot and cache identity.

### 2. Validate the Neovim workflow

- Mark and navigate hunks in normal buffers.
- Explain and preview the hunk at the cursor.
- Stream results into native Neovim surfaces.
- Support evidence jumps and follow-up questions.
- Cancel and mark results stale when input changes.

### 3. Add semantic evidence

- Reuse attached Neovim LSP clients.
- Normalize semantic results into bounded context fragments.
- Add TypeScript syntax evidence and structured invariant claims.
- Keep assurance levels visible and enforce their semantics at schema boundaries.

### 4. Consider additional clients

Only after the editor workflow is validated:

- evaluate a VS Code extension using native editor surfaces;
- evaluate a web client when workspace hosting and isolation are justified;
- optionally add a minimal diagnostic CLI or TUI for engine debugging.

## Proposed issue migration

No GitHub issue is changed by this branch. If the proposal is accepted, use the
following migration:

| Issue | Proposed disposition after acceptance |
| --- | --- |
| #1 — monorepo skeleton | Close after the production-foundation PR merges. |
| #2 — domain schemas | Close after the foundation merges; track source locations and invariant claims separately. |
| #3 — capability contracts | Close after the foundation merges; track editor context and transport schemas separately. |
| #4 — ReviewApi and engine | Close after the foundation merges; create a follow-up for overlays and the daemon boundary. |
| #5 — scheduler | Close after the foundation merges; retain advanced policies under #13. |
| #6 — Git diff source | Close after the foundation merges; create a focused overlay-diff follow-up. |
| #7 — OpenCode V2 runner | Keep as the first real `AgentRunner` milestone. |
| #8 — SQLite | Split completed cache work from the deferred `ReviewStore`. |
| #9 — OpenTUI client | Replace with the Neovim client and daemon vertical slice. |
| #10 — end-to-end slice | Rewrite around Neovim → daemon → engine, including overlays, streaming, and cancellation. |
| #11 — LSP ecosystem | Split editor-supplied intelligence from future daemon-managed language servers. |
| #12 — GitHub diff source | Keep deferred; workspace materialization and isolation remain prerequisites. |
| #13 — post-MVP review and scheduler | Keep deferred. |

## Non-goals for the first product slice

- A standalone TUI as the primary experience.
- A full browser IDE or hosted repository service.
- Arbitrary whole-codebase chat detached from a diff.
- Supporting every editor or language immediately.
- Starting a second language server when the editor already has one.
- Presenting model confidence as proof.
- Silent dependency downloads or hidden process execution.

## Decision record

The current proposal chooses:

- Neovim as the first product client.
- Hunk-centered semantic navigation rather than unrestricted exploration.
- A local editor-neutral daemon boundary.
- Live unsaved-buffer overlays.
- Neovim-provided LSP intelligence first.
- TypeScript as the first invariant-extraction target.
- Evidence tiers instead of undifferentiated confidence.
- Buffer-local, configurable mappings.
- An explicit `wth` executable with no silent installation.
- Removal of the standalone TUI from the proposed MVP, while preserving the
  transport-independent API that allows future clients.

## References

- [Current architecture](./what-the-hunk-architecture.md)
- [Current condensed overview and MVP](./what-the-hunk-overview.md)
- [Neovim API](https://neovim.io/doc/user/api)
- [Visual Studio Code Extension API](https://code.visualstudio.com/api/)
