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

When posting a reply to a PR review comment on your own initiative (not a
human typing through their own `gh`), authenticate as the bot: use
`ghbot api ...` instead of `gh api ...` for that call. `ghbot` is a local
wrapper (`~/.local/bin/ghbot`) that runs `gh` with a GitHub App installation
token, so the reply is attributed to `nicolasluduena-coding-agent[bot]`
rather than impersonating the human account. Everything else — commits,
pushes, `gh pr create`, `gh pr view`, and any action a human is directing
interactively — stays on the normal `gh` session.

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
