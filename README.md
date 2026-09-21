# Know the Map

A local, private, version-exact index of the code a project depends on. Know
the Map divides a package at a pinned version into components, records what
each one does, and anchors every claim to the source lines that support it.
Agents read the index over MCP and can follow any claim back to the lines
behind it.

## Current direction

- The [product plan](./PRODUCT_PLAN.md) is the approved product thesis and scope.
- The [product design context](./PRODUCT.md) describes the users and design principles.
- The [review UI options](./docs/design/UI_OPTIONS.md) are deferred.

## Browse a saved analysis

Requires Bun and Git. Install dependencies with `bun install`, then open a
saved artifact:

```sh
bun run ktm view . --artifact packages/viewer/test-fixtures/analysis.json
```

Producing an artifact is `ktm index` (not here yet); the `analyze` command
that wrote into the project's own `.ktm/` directory is gone. Artifacts are
identified by package — repository, commit, name — and live under
`KTM_HOME` (`$XDG_DATA_HOME/ktm`, falling back to `~/.local/share/ktm`):

```
$KTM_HOME/
  repos/<host>/<owner>/<repo>.git               bare clones
  store/<host>/<owner>/<repo>/<commit>/<name>.json
  index.json                                    name@version -> identity
  harness/opencode.json                         the picker's saved defaults
```

`view` prints a `http://127.0.0.1:…/` address. The server binds an available
port unless `--port 4321` names one, and stops on Ctrl+C.

```sh
# An explicit repository and saved artifact
bun run ktm view /path/to/repository --artifact /path/to/analysis.json
```

Viewing works with a dirty worktree and never starts a model harness.

Navigate the component outline, search names and file paths, and follow the
spine back up to the repository. Interpretations belong to the scope that
produced them. Parts a run never reached are shown as coverage gaps rather
than quietly omitted, and the header reports how much of the submitted
inventory an explored leaf actually reached.

The interface is served on loopback only: requests must carry a loopback
`Host`, and any `Origin` must be the server itself. Nothing is fetched from
outside the process.

**Artifacts from before `version: 2` must be regenerated.** The viewer needs
the package identity and the recorded scope hierarchy, and will not guess
either.

This slice browses a saved analysis. Reading the cited source, live analysis,
and recording your own interpretations are not here yet.
