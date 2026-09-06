# Know the Map by Bleentr

A local-first repository wiki and semantic code-review system. Know the Map connects
hard code evidence with human and AI interpretations, detects when those
interpretations drift from the code, and uses the resulting knowledge to make
changes easier to understand and review.

## Current direction

- [Product plan](./PRODUCT_PLAN.md) — approved product thesis and scope
- [Review UI options](./docs/design/UI_OPTIONS.md)
- [Product design context](./PRODUCT.md)

## Browse a completed analysis

Requires Bun and Git. Install dependencies with `bun install`, then create a fresh
analysis and open its saved result:

```sh
bun run ktm analyze .
bun run ktm view .
```

Open the printed `http://127.0.0.1:…/?token=…` URL. The viewer starts on an available
port; `--port 4321` selects a specific one. Ctrl+C stops the server.

```sh
# Explicit repository and saved artifact
bun run ktm view /path/to/repository --artifact /path/to/analysis.json

# Try the interface on this checkout without making model calls
bun run ktm view . --artifact packages/viewer/test-fixtures/analysis.json
```

The artifact path defaults to `.ktm/analysis.json` relative to the directory where
you invoke the command, matching `analyze`'s output location. Repository discovery
uses the positional path. Viewing works with a dirty working tree and does not
start OpenCode or call a model.

Navigate the component outline, search component names or file paths, and follow
connections to related components. Interpretations belong to the scope that
produced them. Clicking a citation opens source at the analyzed commit with the
cited lines highlighted; file links open the whole file. Browser Back/Forward
preserves component navigation. The analysis is loaded once; restart the viewer
to open a new artifact.

Source is read from Git, checked against the recorded blob hash, and limited to
1 MiB per file. Missing commits, binary files, and invalid evidence ranges remain
visible as source-pane errors. The file inventory records files included in the
analysis, not a guarantee that every line was explored.

**Existing unversioned artifacts must be regenerated.** The viewer requires the
new scope provenance to reconstruct hierarchy reliably; it does not guess parent
links from filenames. Model-local IDs and component names may repeat across scopes.

This slice supports saved analysis browsing. Live analysis, editing, graph canvases,
and PR comparison/diff views are not included yet.
