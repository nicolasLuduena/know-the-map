# What the Hunk?

A headless, stateless diff-analysis engine: explains hunks from a git diff via
an agent runner, with semantic context and a terminal UI.

The current repository is the production foundation: validated domain values,
scoped plugin registration, scheduling, the headless API, a local Git source,
and a SQLite explanation cache. OpenCode, review-state persistence, and the
OpenTUI client remain explicit capability boundaries without placeholder
implementations.

- [Condensed overview](./what-the-hunk-overview.md) — quick orientation + MVP scope
- [Architecture](./what-the-hunk-architecture.md) — full design document
