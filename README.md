# Know the Map by Bleentr

A local-first repository wiki and semantic code-review system. Know the Map connects
hard code evidence with human and AI interpretations, detects when those
interpretations drift from the code, and uses the resulting knowledge to make
changes easier to understand and review.

## Current direction

- [Product plan](./PRODUCT_PLAN.md) — approved product thesis and scope
- [Review UI options](./docs/design/UI_OPTIONS.md)
- [Product design context](./PRODUCT.md)

## Browse a saved analysis

Requires Bun and Git. Install dependencies with `bun install`, then create an
analysis and open it:

```sh
bun run ktm analyze .
bun run ktm view .
```

`analyze` asks for a provider, model, and division depth. To run it without
prompts (scripts, CI), pass them as flags; `--model` takes `provider/model`
as the picker lists them, and every flag also reads a `KTM_*` variable:

```sh
bun run ktm analyze . --model opencode-go/deepseek-v4.1-flash --variant low --max-depth 5
```

Each scope is analyzed in a model session of its own, and sibling components
are explored concurrently — up to `--max-concurrency` (default 4,
`KTM_MAX_CONCURRENCY`) at a time. `--max-harness-calls` remains an exact
budget across all of them.

`view` prints a `http://127.0.0.1:…/` address. The server binds an available
port unless `--port 4321` names one, and stops on Ctrl+C.

```sh
# An explicit repository and saved artifact
bun run ktm view /path/to/repository --artifact /path/to/analysis.json

# See the interface without making any model calls
bun run ktm view . --artifact packages/viewer/test-fixtures/analysis.json
```

The artifact path defaults to `.ktm/analysis.json`, matching where `analyze`
writes. Viewing works with a dirty worktree and never starts a model harness.

Navigate the component outline, search names and file paths, and follow the
spine back up to the repository. Interpretations belong to the scope that
produced them. Parts a run never reached are shown as coverage gaps rather
than quietly omitted, and the header reports how much of the submitted
inventory an explored leaf actually reached.

The interface is served on loopback only: requests must carry a loopback
`Host`, and any `Origin` must be the server itself. Nothing is fetched from
outside the process.

**Artifacts from before `version: 1` must be regenerated.** The viewer needs
the recorded scope hierarchy and will not guess it from file paths.

This slice browses a saved analysis. Reading the cited source, live analysis,
and recording your own interpretations are not here yet.
