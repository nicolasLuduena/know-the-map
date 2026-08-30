import { join } from "node:path";
import { Config, Effect, Option, Redacted, Schema } from "effect";

export const OPENCODE_CONFIG = {
  $schema: "https://opencode.ai/config.json",
  provider: {
    "opencode-go": {
      name: "OpenCode Go",
      package: "@ai-sdk/openai-compatible",
      env: ["OPENCODE_GO_API_KEY"],
      settings: { baseURL: "https://opencode.ai/zen/go/v1" },
      models: {
        "glm-5.3-flash": {
          name: "GLM 5.3 Flash",
          settings: { reasoningEffort: "low" },
          limit: { context: 1_000_000, output: 384_000 },
          cost: {
            input: 0.22,
            output: 0.66,
            cache: { read: 0.007, write: 0 },
          },
          compatibility: {
            reasoningField: "reasoning_content",
            requireReasoning: true,
            maxTokensField: "max_tokens",
          },
        },
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
} as const;

const OpenCodeGoAuthFile = Schema.Struct({
  "opencode-go": Schema.optional(Schema.Struct({ key: Schema.String })),
});

export const resolveOpenCodeGoApiKey = Effect.fn("resolveOpenCodeGoApiKey")(
  function*(): Effect.fn.Return<string | undefined, Config.ConfigError> {
    const fromEnvironment = yield* Config.redacted("OPENCODE_GO_API_KEY").pipe(
      Config.option,
    );
    if (Option.isSome(fromEnvironment)) {
      return Redacted.value(fromEnvironment.value);
    }

    const home = yield* Config.string("HOME");
    return yield* Effect.tryPromise(() =>
      Bun.file(join(home, ".local/share/opencode/auth.json")).json()
    ).pipe(
      Effect.map(Schema.decodeUnknownOption(OpenCodeGoAuthFile)),
      Effect.map(Option.map((auth) => auth["opencode-go"]?.key)),
      Effect.map(Option.getOrUndefined),
      Effect.catch(() => Effect.succeed(undefined)),
    );
  },
);

export const OPENCODE_CREATE_OPTIONS = {
  config: {
    directory: "/tmp/harness-probe/opencode",
    project: false,
    content: JSON.stringify(OPENCODE_CONFIG),
  },
} as const;
