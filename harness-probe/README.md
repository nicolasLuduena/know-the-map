# harness-probe

A bun script that sends a structured message to a Pi agent session and receives a
structured message back, using Effect.

- `src/schemas.ts` — Effect.Schema types for the request/response plus the typebox
  wire schema for the `submit_result` tool.
- `src/pi-harness.ts` — the `PiHarness` Effect service: resolves the model, creates
  a Pi session, registers the `submit_result` tool, prompts, and validates the
  submitted payload.
- `src/main.ts` — the Effect program entrypoint.

## Run

```bash
bun install
bun run start
```

## Model

Default model is `opencode-go/glm-5.3-flash` (OpenCode Go gateway,
`https://opencode.ai/zen/go/v1`). The API key is read from opencode's auth store
(`~/.local/share/opencode/auth.json`). Override either:

```bash
#PI_MODEL="opencode-go/glm-5.3-flash" bun run start
OPENCODE_GO_API_KEY="..." bun run start
```

## How the structured message works

1. The request (`EchoRequest`) is JSON-encoded into the prompt.
2. The agent's only tool is `submit_result`, whose parameters mirror the
   `EchoResult` schema (typebox for the wire, Effect.Schema for validation).
3. The tool's `execute` handler captures the submitted arguments.
4. `PiHarness` decodes the captured payload with Effect.Schema and returns a typed
   `EchoResult` or a tagged `PiError`.
