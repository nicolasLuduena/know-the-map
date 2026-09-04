import { join } from "node:path";
import type { OpenCode } from "@opencode-ai/sdk/effect";
import { Effect, Option, Schema } from "effect";

/**
 * Providers this harness knows how to authenticate, mapped to the env var
 * their driver reads its key from (sourced from opencode's bundled catalog
 * data, not a public API — confirmed live per provider). A provider
 * present in `auth.json` but absent here is silently excluded from
 * `listModels()` (tracked: #33).
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

/** Reads opencode's auth file as a raw record; `{}` if missing or unparseable. */
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
 * The API key comes exclusively from opencode's auth file — no env var
 * fallback. Only `type: "api"` entries are usable; other auth types
 * (OAuth, etc.) are out of scope here (tracked: #33).
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
 * Opencode's config directory. Avoids the user's and the project's config.
 * Not the working directory, which gets passed per session (see
 * opencode-harness.ts). `project: false` also means the analyzed repo's own
 * skills and AGENTS.md never load here — worth a second look (see PR
 * discussion).
 */
export const buildCreateOptions = (scratchDirectory: string) =>
  ({
    config: {
      directory: scratchDirectory,
      project: false,
      content: JSON.stringify(buildHostConfig()),
    },
  }) satisfies OpenCode.CreateOptions;
