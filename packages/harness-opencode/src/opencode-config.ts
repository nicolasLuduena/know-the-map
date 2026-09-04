import { join } from "node:path";
import { Effect, Option, Schema } from "effect";

/**
 * Providers this harness knows how to authenticate, mapped to the env var
 * their driver reads its key from. Sourced from opencode's own bundled
 * catalog data (not a public runtime API — `opencode-go`'s real entry
 * declares `env: ["OPENCODE_API_KEY"]`, confirmed live; `openrouter`'s
 * confirmed against `@opencode-ai/ai`'s source). A provider present in
 * auth.json but absent here is silently excluded from `listModels()`, not
 * a crash — broader/graceful multi-provider handling is a tracked follow-up,
 * not built here.
 */
export const PROVIDER_ENV_VARS: Readonly<Record<string, string>> = {
  "opencode-go": "OPENCODE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/**
 * The embedded host is configured with mutation denied: the analyze session
 * may read the repository (and search the web for what it reads) but never
 * change it, ask a human, or spawn work we cannot await. Rules evaluate
 * last-match-wins, and anything not matched falls back to "ask" — fatal for
 * a headless run — so every allowed action is listed explicitly. `.env`
 * reads are re-denied after the blanket `read: *` allow (OpenCode's own
 * defaults only `ask`, and our allow would override them): a headless ask
 * hangs, a blanket allow leaks secrets.
 *
 * No `provider` block: opencode's own bundled catalog (from models.dev)
 * already registers `opencode-go`, `openrouter`, and others, with real
 * cost/limit/variant data — confirmed live, richer than anything we'd hand
 * register. `mcp.servers` stays hardcoded empty: enabling any server needs
 * per-server permission policy that doesn't exist yet (see issue #27).
 */
export const buildHostConfig = () =>
  ({
    $schema: "https://opencode.ai/config.json",
    mcp: { servers: {} },
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

const AuthEntry = Schema.Struct({ type: Schema.Literal("api"), key: Schema.String });

/**
 * Reads opencode's auth file as a raw record. `{}` on any missing or
 * unparseable file — "no entries" is a normal result, not a failure.
 */
const readAuthEntries: Effect.Effect<Record<string, unknown>> = Effect.gen(function* () {
  const home = process.env["HOME"];
  if (home === undefined) {
    return {};
  }
  const authFile = join(home, ".local/share/opencode/auth.json");
  const contents = yield* Effect.tryPromise({
    try: () => Bun.file(authFile).json(),
    catch: (cause) => cause,
  }).pipe(Effect.option);
  if (Option.isNone(contents)) {
    return {};
  }
  return Option.getOrElse(
    Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))(contents.value),
    () => ({}),
  );
});

/**
 * The API key comes exclusively from opencode's auth file. No environment
 * variable fallback: one place to look, one place to fix. The file holds
 * one entry per provider, so a given `providerID` being absent is a normal
 * decode result, not an error. Only `type: "api"` entries are usable —
 * other auth types (OAuth, etc.) are out of scope for this harness.
 */
export const resolveApiKey = (providerID: string): Effect.Effect<string | undefined> =>
  readAuthEntries.pipe(
    Effect.map((entries) =>
      Option.getOrUndefined(
        Schema.decodeUnknownOption(AuthEntry)(entries[providerID]).pipe(
          Option.map(({ key }) => key),
        ),
      ),
    ),
  );

/**
 * Provider IDs we can both authenticate (a `type: "api"` entry in
 * auth.json) and inject a key for (`PROVIDER_ENV_VARS`). Drives which
 * providers `OpencodeHarnessLive` authenticates at boot.
 */
export const listUsableProviderIds: Effect.Effect<ReadonlyArray<string>> = readAuthEntries.pipe(
  Effect.map((entries) =>
    Object.keys(PROVIDER_ENV_VARS).filter((id) =>
      Option.isSome(Schema.decodeUnknownOption(AuthEntry)(entries[id])),
    ),
  ),
);

/**
 * Scratch options for `OpenCode.create`. `directory` is where the embedded
 * host *discovers config files* — a scratch path so neither the user's nor
 * the analyzed repository's config can leak into the run; `project: false`
 * disables project-level discovery, and `content` is the only config it
 * ever sees. Note this is not the session's working directory: that is
 * passed per session as `location.directory` (see opencode-harness.ts).
 */
export const buildCreateOptions = (scratchDirectory: string) =>
  ({
    config: {
      directory: scratchDirectory,
      project: false,
      content: JSON.stringify(buildHostConfig()),
    },
  }) as const;
