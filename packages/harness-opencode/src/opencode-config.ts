import { join } from "node:path";
import { Effect, Option, Schema } from "effect";

// TODO(config): the model belongs to a run configuration, not a constant.
export const OPENCODE_MODEL = "opencode-go/deepseek-v4-flash";

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
 * TODO(config): this is the whole host policy; it should be loadable from
 * a configuration file once there is more than the analyze slice to
 * configure.
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
    // Nothing may block on user interaction or subagents: the host is
    // embedded and headless.
    { action: "question", resource: "*", effect: "deny" },
    { action: "task", resource: "*", effect: "deny" },
    // TODO(config): MCP servers can mutate and reach the network with
    // tool names we cannot predict; gating them per-server needs the same
    // config story as this ruleset (tracked as an issue).
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
} as const;

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
 *
 * TODO(config): host bootstrap (scratch directory, model, key handoff)
 * should become a proper init step — tracked as an issue.
 */
export const OPENCODE_CREATE_OPTIONS = {
  config: {
    directory: "/tmp/what-the-hunk/opencode",
    project: false,
    content: JSON.stringify(OPENCODE_CONFIG),
  },
} as const;
