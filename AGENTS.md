# Coding standards

Before writing any TypeScript code, first read `docs/coding-standards.md`
**completely**. It aggregates the repository's preferences and is updated as
new ones are settled. The Effect section below then governs Effect code.

# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

# GitHub identity

When posting an issue comment, PR comment, or PR review reply on your own
initiative (not a human typing through their own `gh`), authenticate as the
bot: use `ghbot ...` instead of `gh ...` for that call. `ghbot` is a local
wrapper (`~/.local/bin/ghbot`) that runs `gh` with a GitHub App installation
token, so the comment is attributed to `nicolasluduena-coding-agent[bot]`
rather than impersonating the human account. Everything else — commits,
pushes, `gh pr create`, `gh pr view`, and any action a human is directing
interactively — stays on the normal `gh` session.

Every body posted through `ghbot` ends with a fingerprint line naming the
model that wrote it, exactly in this shape (blank line before it):

```
_Posted by Claude Opus 5 (`claude-opus-5`) via Claude Code._
```

Substitute your own model name, model id, and tool. `ghbot` refuses a body
without this line.

# Monorepo

- Bun workspaces: `packages/*` (libraries) and `apps/*` (executables).
- Shared dependency versions live in the `catalog` of the root `package.json`
  and are referenced with the `catalog:` protocol.
- All implementations that are not designed yet fail loudly with
  `NotImplementedError` from `@know-the-map/harness`.

# Permissions and embedded hosts

An embedded host (e.g. the OpenCode adapter in `packages/harness-opencode`)
runs headless — nothing can block on a human answering an `"ask"` prompt.
Every permission action the host can reach needs an explicit `allow`/`deny`
rule; never rely on the framework's unmatched-action default. Reads outside
the session's own directory go through a distinct action from a normal
read (e.g. OpenCode's `external_directory`) — check the host's own
path-resolution source before assuming one rule covers both.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `nicolasLuduena/know-the-map` (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage labels, unchanged: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
