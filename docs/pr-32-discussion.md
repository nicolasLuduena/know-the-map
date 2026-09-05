# PR #32 review discussion log

A record of the design discussions from the review of [PR #32](https://github.com/nicolasLuduena/know-the-map/pull/32)
("Interactive provider/model/reasoning selection for `ktm analyze`"), kept
alongside the code since several of these explanations are too long to live
comfortably as a PR comment and are worth having on hand the next time this
area of the code changes.

## Resolution tracker

| # | Topic | Status |
|---|-------|--------|
| 1 | `external_directory` permission gap | Fixed — `bccaf34` |
| 2 | `maxDepth` as an interactive prompt | Fixed — `3402250` |
| 3 | Mechanical review feedback | Fixed — `2fea173` |
| 4 | `PROVIDER_ENV_VARS` hardcoding | No action — confirmed no public API alternative exists |
| 5 | `location.directory` vs. permission `resource: "*"` | Clarified — see below |
| 6 | ELI5 `Ref`/`Deferred` | Explained — see below |
| 7 | ELI5 `close()` no-op | Explained — see below |
| 8 | `BLOCKED_TOOLS` vs. permission denies | Discussed in depth — see below |
| 9 | Is `maxHarnessCalls` a relevant metric? | Answered in chat; no issue needed, ties to #29 |
| 10 | `maxClarifications` naming | Answered — see below |
| 11 | Explore a session about to time out | Filed as a comment on #29 |
| A | `.pem`/secret-file reads | No rule added — see below for why the underlying premise needed correcting first |
| B | Repo's own skills/`AGENTS.md` not loading | Filed as [#34](https://github.com/nicolasLuduena/know-the-map/issues/34) |
| C | `readAuthEntries` swallows permission errors | Fixed — permission errors (`EACCES`/`EPERM`) now surface as `HostFailureError`; missing/malformed auth.json still silently mean "not logged in" |
| D | `.ktm/harness.json` not namespaced by adapter | Fixed — now `.ktm/harness/opencode.json` |
| E | Concurrent `ktm analyze` runs racing on `.ktm/` | Filed as [#35](https://github.com/nicolasLuduena/know-the-map/issues/35) |
| F | `maxDepth` default too small | Fixed — default raised from 3 to 7 |
| G | No breadth limit on division | Filed as [#36](https://github.com/nicolasLuduena/know-the-map/issues/36) |

## `packages/harness-opencode/src/opencode-config.ts`

### A — `.pem`/secret-file reads aren't specially denied

The question was whether opencode already denies `.env`-like files by
default, in which case a `.pem` rule might be redundant to add. Checking
opencode's own source settles it the other way: opencode's *own* default
behavior for a path matching `.env` is `"ask"`, not `"deny"` — the `.env`
deny in `buildHostConfig()` is entirely our own rule, added because an
unmatched-action "ask" hangs a headless run. There is no equivalent
built-in handling, of any kind, for `.pem`/`.key`/other secret-shaped
files — they're read exactly like any other file in the repo today, under
the blanket `read: "*"` allow.

Decision: no rule added. A `.pem` file inside the analyzed repo is no more
exposed by this than it would be to a human browsing the same repo — the
tool doesn't expose anything beyond what's already committed there.

### C — permission errors reading `auth.json`

`readAuthEntries` used to collapse three different situations
(file missing, file present but unparseable, file present but unreadable
due to permissions) into the same silent `{}`. The first two genuinely mean
"nothing to report" — there's no key either way. The third is different: a
key may well be sitting in that file, and we simply couldn't see it, which
is a real operational problem that looks identical to "user hasn't logged
in" if left silent.

Fixed: `readAuthEntries` now distinguishes `EACCES`/`EPERM` from everything
else. A permission error propagates as a `HostFailureError`; a missing file
(`ENOENT`) or a parse/schema failure still resolves to `{}`, unchanged.

## `packages/harness-opencode/src/opencode-harness.ts`

### 5 — `location.directory` vs. the `resource: "*"` permission rules

These are two different mechanisms, not two views on the same one.

The permission block's `resource: "*"` rules (on `read`, `grep`, `glob`,
`list`, and now `external_directory`) govern **which paths the read-family
tools are allowed to touch at all** — the actual security boundary. A read
inside the session directory is checked against the `read` action; a read
outside it is checked against the separate `external_directory` action,
which we now deny explicitly (see item 1 in the tracker) instead of letting
it fall to the unmatched-action `"ask"` default.

`location.directory`, passed into `pluginSession.create()`, is unrelated to
that boundary. It sets the session's **working directory** — what a
relative path means to the model, i.e. where its own path resolution
starts from. Get it wrong and the model's relative reads point somewhere
unexpected; it grants or denies nothing by itself. The permission rules are
what actually decide what can be read.

### 6 — ELI5: `Ref` and `Deferred`

`Ref` is a mutable cell that can be read and updated atomically — think of
it as a `let` variable that's safe to share across concurrent code.
`Deferred` is a one-shot promise: something creates it empty, exactly one
thing resolves it later, and anyone waiting on it unblocks at that moment.

`HostState.systemPrompt` and `HostState.maxGenerationTokens` are `Ref`s
because the plugin's `context` hook reads them fresh on *every* model
generation, but `start()` only learns their real values *after* the host
has already booted (the layer boots once; `start()` runs once per
analysis). Boot creates each `Ref` with a placeholder; `start()` overwrites
it with the real value; the hook always reads whatever is currently there.

`HostState.session` is a `Deferred` instead, because it's resolved exactly
once — when the plugin finishes booting — and everything else (the layer's
own setup code) just waits for that single moment via
`Deferred.await(state.session)`.

### 7 — ELI5: why `close()` is `() => Effect.void`

An earlier draft of this design injected each provider's API key
*per session* (after the interactive provider pick), which meant `close()`
would have needed to actually restore that session's env var when the
session ended.

The live experiment recorded in the plan file
(`.claude/plans/help-me-figure-out-snappy-kite.md`) showed that doesn't
work: `opencode.model.list()` only shows providers that were already
authenticated at `OpenCode.create()` time, so every usable provider's key
has to be injected once, at layer boot, before any session exists — not
deferred to a per-session step. Once key injection moved to boot time, the
cleanup for it moved with it: it's released when the whole `Harness` layer
tears down (via the `Effect.acquireRelease` in `OpencodeHarnessLive`), not
per session. By the time an individual session ends, there is no
session-scoped auth state left to release — `close()` being a no-op is the
correct reflection of that, not a leftover from an earlier draft.

### 8 — `BLOCKED_TOOLS` vs. the permission denies: is this double work?

This needs the fuller discussion the user asked for, not a one-line
defense. There are two independent layers doing related but distinct jobs:

- `BLOCKED_TOOLS` (in `opencode-harness.ts`) filters the tool list the
  model is shown, inside the `context` hook, before each generation. The
  model literally cannot attempt to call a tool that was filtered out of
  its own function list.
- The permission block (in `opencode-config.ts`'s `buildHostConfig()`)
  denies the corresponding actions (`edit`, `bash`, `webfetch`, `question`,
  `task`) at the host level, independent of what the model's tool list
  looks like.

The case for keeping both: they fail differently and at different points.
If `BLOCKED_TOOLS` has a bug (a typo in a tool name, a new tool opencode
adds that isn't in the set yet), the permission layer is what actually
stops a mutation from happening — the model attempts the call, and it's
denied at the host level instead of silently succeeding. If the permission
config has a gap instead (as the `external_directory` case actually turned
out to have — see item 1), the tool-list filter is what stops the model
from ever trying, sidestepping whatever the permission gap would otherwise
have allowed. Neither layer alone is a complete guarantee against both
failure modes; together they are.

The real cost isn't runtime overhead — it's that the two lists have to
stay in sync by hand. `BLOCKED_TOOLS` names tool identifiers
(`"edit"`, `"patch"`, ...); the permission block names permission actions
(`"edit"`, `"bash"`, ...). Nothing currently enforces that a tool added to
one is added to the other. That drift risk is real but not urgent — no
tests or CI check cross-consistency between the two lists today.
Worth its own follow-up if it starts to bite (e.g. a test asserting every
`BLOCKED_TOOLS` entry has a matching `deny` permission action), but not
something to build speculatively before it's actually caused a problem.

## `packages/hermeneut/src/hermeneut.ts`

### 9 — Is `maxHarnessCalls` a relevant metric?

Raw call count is a decent proxy for "how much recursive work has this run
done", and it's simple and deterministic, but it doesn't directly bound
cost or wall-clock time — one call can be cheap or expensive depending on
scope size. No GitHub issue was filed for this specifically: `maxHarnessCalls`
stays as the structural safety net against runaway recursion regardless of
cost, and #29 (surface analysis cost, ask before stopping) already tracks
the complementary cost/token-based bound as a separate, not competing,
metric.

### 10 — Should `maxClarifications` be named `maxRetries`?

Kept as `maxClarifications`. A "retry" implies redoing the same thing
hoping for a different result; what the loop actually does is closer to a
correction round — each clarification prompt carries specific feedback
about what was wrong (a schema violation, or an anti-hallucination
failure), and the model is asked to fix that particular problem, not just
try blindly again. `maxClarifications` names what the loop is actually
doing; `maxRetries` would undersell that real information flows back into
each round. This is closer to a taste call than a correctness one — worth
revisiting if it still reads wrong in practice.
