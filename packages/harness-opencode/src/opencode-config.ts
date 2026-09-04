import { join } from "node:path";
import { Config, Effect, Option, Schema } from "effect";

/**
 * Everything the embedded opencode host needs to boot: which model to use,
 * how long a turn may run, the per-generation token cap, where its scratch
 * config directory lives, and which MCP servers it may load (see
 * `mcpServers` below — plumbed but always empty today).
 */
export const OpencodeHarnessConfig = Schema.Struct({
  model: Schema.String,
  turnTimeout: Schema.Duration,
  maxGenerationTokens: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  scratchDirectory: Schema.String,
  mcpServers: Schema.Record(Schema.String, Schema.Unknown),
});
export type OpencodeHarnessConfig = Schema.Schema.Type<typeof OpencodeHarnessConfig>;

/**
 * The one model `buildHostConfig`'s fixed catalog knows how to serve.
 * `layerFromConfig` guards that a resolved config's `model` matches this
 * before booting — not a fallback value, just the catalog's only entry.
 */
export const SUPPORTED_MODEL = "opencode-go/deepseek-v4-flash";

/**
 * Host boot config, resolved once when `OpencodeHarnessLive` is
 * constructed — process lifetime, not per-`analyze()`-call. Every field
 * with an env surface is required: no fallback default, so a missing
 * `KTM_OPENCODE_*` variable fails loudly with `Config.ConfigError` at boot
 * instead of silently running with a baked-in value. `apps/cli/src/main.ts`
 * provides every layer before any command's flags are parsed, so wiring
 * this to CLI flags instead would need a bigger restructuring than issue
 * #27 asks for.
 */
export const loadOpencodeHarnessConfig: Config.Config<OpencodeHarnessConfig> = Config.all({
  model: Config.string("KTM_OPENCODE_MODEL"),
  turnTimeout: Config.duration("KTM_OPENCODE_TURN_TIMEOUT"),
  maxGenerationTokens: Config.int("KTM_OPENCODE_MAX_GENERATION_TOKENS"),
  scratchDirectory: Config.string("KTM_OPENCODE_SCRATCH_DIRECTORY"),
  // No env surface yet, by design, not oversight: enabling any server
  // needs per-server permission policy that doesn't exist yet.
  // `layerFromConfig` fails loudly if this is ever non-empty (see
  // opencode-harness.ts).
  mcpServers: Config.succeed({}),
});

/**
 * The embedded host is configured with the opencode-go provider and with
 * mutation denied: the analyze session may read the repository (and search
 * the web for what it reads) but never change it, ask a human, or spawn
 * work we cannot await. Rules evaluate last-match-wins, and anything not
 * matched falls back to "ask" — fatal for a headless run — so every
 * allowed action is listed explicitly. `.env` reads are re-denied after
 * the blanket `read: *` allow (OpenCode's own defaults only `ask`, and our
 * allow would override them): a headless ask hangs, a blanket allow leaks
 * secrets.
 *
 * The provider/model catalog stays fixed here: `config.model` only selects
 * which catalog entry boots (`opencode-harness.ts` guards that the
 * selection actually matches this catalog). `cost` and `limit` are
 * deliberately omitted — both are optional per opencode's own Model schema
 * and exist only to feed opencode's own dollar-cost/context-limit
 * accounting; we don't rely on either today. `compatibility` stays: it
 * tells the openai-compatible adapter how to read this specific model's
 * reasoning output and token-limit parameter, which plausibly affects
 * whether requests parse correctly, not just bookkeeping.
 */
export const buildHostConfig = (config: OpencodeHarnessConfig) =>
  ({
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
            compatibility: {
              reasoningField: "reasoning_content",
              requireReasoning: true,
              maxTokensField: "max_tokens",
            },
          },
        },
      },
    },
    mcp: { servers: config.mcpServers },
    permissions: [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "bash", resource: "*", effect: "deny" },
      { action: "webfetch", resource: "*", effect: "deny" },
      // Nothing may block on user interaction or subagents: the host is
      // embedded and headless.
      { action: "question", resource: "*", effect: "deny" },
      { action: "task", resource: "*", effect: "deny" },
      // Reads are explicitly allowed so no path ever lands in "ask".
      { action: "read", resource: "*", effect: "allow" },
      { action: "grep", resource: "*", effect: "allow" },
      { action: "glob", resource: "*", effect: "allow" },
      { action: "list", resource: "*", effect: "allow" },
      { action: "websearch", resource: "*", effect: "allow" },
      { action: "skill", resource: "*", effect: "allow" },
      { action: "read", resource: "*.env", effect: "deny" },
      { action: "read", resource: "*.env.*", effect: "deny" },
      { action: "read", resource: "*.env.example", effect: "allow" },
    ],
  }) as const;

const AuthEntry = Schema.Struct({ key: Schema.String });

/**
 * The API key comes exclusively from the opencode auth file. No environment
 * variable fallback: one place to look, one place to fix. The file holds
 * one entry per provider, so the `opencode-go` entry being absent is a
 * normal decode result, not an error — hence the record lookup instead of
 * a per-provider optional field.
 */
export const resolveOpenCodeGoApiKey: Effect.Effect<string | undefined> = Effect.gen(function* () {
  const home = process.env["HOME"];
  if (home === undefined) {
    return undefined;
  }
  const authFile = join(home, ".local/share/opencode/auth.json");
  // A missing or unparseable file is "no key", not a failure: `Effect.option`
  // turns the rejected promise into a None.
  const contents = yield* Effect.tryPromise({
    try: () => Bun.file(authFile).json(),
    catch: (cause) => cause,
  }).pipe(Effect.option);
  if (Option.isNone(contents)) {
    return undefined;
  }
  const entries = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))(
    contents.value,
  );
  if (Option.isNone(entries)) {
    return undefined;
  }
  const entry = entries.value["opencode-go"];
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(AuthEntry)(entry).pipe(Option.map(({ key }) => key)),
  );
});

/**
 * Scratch options for `OpenCode.create`. `config.directory` is where the
 * embedded host *discovers config files* — a scratch path so neither the
 * user's nor the analyzed repository's config can leak into the run;
 * `project: false` disables project-level discovery, and `content` is the
 * only config it ever sees. Note this is not the session's working
 * directory: that is passed per session as `location.directory` (see
 * opencode-harness.ts).
 */
export const buildCreateOptions = (config: OpencodeHarnessConfig) =>
  ({
    config: {
      directory: config.scratchDirectory,
      project: false,
      content: JSON.stringify(buildHostConfig(config)),
    },
  }) as const;
