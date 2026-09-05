import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Effect, Option, Schema } from "effect";

/**
 * The last interactive choice, so the next run pre-selects it instead of
 * starting fresh. Prompts still always run — this only changes defaults.
 */
export const HarnessPreferences = Schema.Struct({
  providerId: Schema.String,
  modelId: Schema.String,
  variantId: Schema.optional(Schema.String),
  turnTimeout: Schema.Duration,
  maxGenerationTokens: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
});
export type HarnessPreferences = Schema.Schema.Type<typeof HarnessPreferences>;

// Namespaced by adapter (opencode vs. a future pi) so two harnesses'
// remembered choices never collide or overwrite each other.
const PREFERENCES_DIR = join(".ktm", "harness");
const PREFERENCES_PATH = join(PREFERENCES_DIR, "opencode.json");

/**
 * A missing or malformed `.ktm/harness/opencode.json` is "no saved
 * preferences", never a failure — the prompts just start with no
 * pre-selected default.
 */
export const readHarnessPreferences: Effect.Effect<Option.Option<HarnessPreferences>> = Effect.gen(
  function* () {
    const contents = yield* Effect.tryPromise({
      try: () => Bun.file(PREFERENCES_PATH).json(),
      catch: (cause) => cause,
    }).pipe(Effect.option);
    if (Option.isNone(contents)) {
      return Option.none();
    }
    return Schema.decodeUnknownOption(HarnessPreferences)(contents.value);
  },
);

export const writeHarnessPreferences = (preferences: HarnessPreferences): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Effect.sync(() => mkdirSync(PREFERENCES_DIR, { recursive: true }));
    const encoded = yield* Schema.encodeEffect(HarnessPreferences)(preferences).pipe(Effect.orDie);
    yield* Effect.tryPromise(() =>
      Bun.write(PREFERENCES_PATH, `${JSON.stringify(encoded, null, 2)}\n`),
    ).pipe(Effect.orDie);
  });
