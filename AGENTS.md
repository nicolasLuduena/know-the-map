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

# Monorepo

- Bun workspaces: `packages/*` (libraries) and `apps/*` (executables).
- Shared dependency versions live in the `catalog` of the root `package.json`
  and are referenced with the `catalog:` protocol.
- `harness-probe/` is a standalone probe kept for reference; it is not part of
  the workspace graph. Ideas are transplanted from it manually.
- All implementations that are not designed yet fail loudly with
  `NotImplementedError` from `@know-the-map/harness`.
