# harness-probe

A Bun probe that sends a typed request to an agent session and receives a typed
tool submission back, using Effect.

- `src/schemas.ts` — Effect.Schema types for the request/response plus the typebox
  wire schema for the `submit_result` tool.
- `src/pi-harness.ts` — the `PiHarness` Effect service: resolves the model, creates
  a Pi session, registers the `submit_result` tool, prompts, and validates the
  submitted payload.
- `src/opencode2-harness.ts` — the embedded OpenCode Effect service. It activates
  an in-process plugin, restricts the session to `submit_result`, waits for the
  session to finish, and validates the submitted payload.
- `src/main.ts` and `src/main-opencode2.ts` — the Pi and embedded OpenCode
  entrypoints.

## Run

```bash
bun install
bun run start:oc2
```

## Model

The embedded OpenCode harness defaults to `opencode-go/deepseek-v4-flash` and
also supports `opencode-go/glm-5.3-flash`. The API key is read from
`OPENCODE_GO_API_KEY` first, then OpenCode's auth store at
`~/.local/share/opencode/auth.json`.

```bash
OC2_MODEL="opencode-go/glm-5.3-flash" bun run start:oc2
OPENCODE_GO_API_KEY="..." bun run start:oc2
```

The legacy Pi probe remains available with `bun run start` and uses `PI_MODEL`.

## How the structured message works

1. The request (`EchoRequest`) is JSON-encoded into the prompt.
2. The agent's only tool is `submit_result`, whose parameters mirror the
   `EchoResult` schema (Effect Schema in OpenCode; TypeBox on the Pi wire).
3. The tool's `execute` handler captures the submitted arguments.
4. The harness decodes the captured payload with Effect Schema and returns a
   typed `EchoResult` or a tagged error.
