import { join } from "node:path";
import { Effect, Option, Schema } from "effect";

export const OPENCODE_MODEL = "opencode-go/deepseek-v4-flash";

/**
 * The embedded host is configured with the opencode-go provider and with
 * mutation denied: the analyze session may read the repository but never
 * change it.
 */
export const OPENCODE_CONFIG = {
  $schema: "https://opencode.ai/config.json",
  provider: {
    "opencode-go": {
      name: "OpenCode Go",
      package: "@ai-sdk/openai-compatible",
      env: ["OPENCODE_GO_API_KEY"],
      settings: { baseURL: "https://opencode.ai/zen/go/v1" },
      models: {
        "deepseek-v4-flash": {
          name: "DeepSeek V4 Flash",
          settings: { reasoningEffort: "low" },
          limit: { context: 1_000_000, output: 384_000 },
          cost: {
            input: 0.07,
            output: 0.14,
            cache: { read: 0.0014, write: 0 },
          },
          compatibility: {
            reasoningField: "reasoning_content",
            requireReasoning: true,
            maxTokensField: "max_tokens",
          },
        },
      },
    },
  },
  permissions: [
    { action: "edit", resource: "*", effect: "deny" },
    { action: "bash", resource: "*", effect: "deny" },
    { action: "webfetch", resource: "*", effect: "deny" },
    { action: "websearch", resource: "*", effect: "deny" },
    // Nothing may block on user interaction or subagents: the host is
    // embedded and headless.
    { action: "question", resource: "*", effect: "deny" },
    { action: "task", resource: "*", effect: "deny" },
    // Reads are explicitly allowed so no path ever lands in "ask".
    { action: "read", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "list", resource: "*", effect: "allow" },
  ],
} as const;

const OpenCodeGoAuthFile = Schema.Struct({
  "opencode-go": Schema.optional(Schema.Struct({ key: Schema.String })),
});

/**
 * The API key comes exclusively from the opencode auth file. No environment
 * variable fallback: one place to look, one place to fix.
 */
export const resolveOpenCodeGoApiKey: Effect.Effect<string | undefined> = Effect.gen(function* () {
  const home = process.env["HOME"];
  if (home === undefined) {
    return undefined;
  }
  const authFile = join(home, ".local/share/opencode/auth.json");
  const auth = yield* Effect.tryPromise({
    try: () => Bun.file(authFile).json() as Promise<unknown>,
    catch: () => undefined,
  }).pipe(Effect.option);
  if (Option.isNone(auth)) {
    return undefined;
  }
  const decoded = Schema.decodeUnknownOption(OpenCodeGoAuthFile)(auth.value);
  if (Option.isNone(decoded)) {
    return undefined;
  }
  const entry = decoded.value["opencode-go"];
  return entry === undefined ? undefined : entry.key;
});

export const OPENCODE_CREATE_OPTIONS = {
  config: {
    directory: "/tmp/what-the-hunk/opencode",
    project: false,
    content: JSON.stringify(OPENCODE_CONFIG),
  },
} as const;
