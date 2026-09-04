import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Effect, Option, Schema } from "effect";

/**
 * The last provider/model/variant/timing choice made interactively, so the
 * next `ktm analyze` run can pre-select it instead of starting from
 * scratch. Purely CLI-level UX state — the prompts still always run (no
 * flag skips them), this only changes their defaults.
 */
export const HarnessPreferences = Schema.Struct({
  providerId: Schema.String,
  modelId: Schema.String,
  variantId: Schema.optional(Schema.String),
  turnTimeout: Schema.Duration,
  maxGenerationTokens: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
});
export type HarnessPreferences = Schema.Schema.Type<typeof HarnessPreferences>;

const PREFERENCES_PATH = join(".ktm", "harness.json");

/**
 * A missing or malformed `.ktm/harness.json` is "no saved preferences",
 * never a failure — the prompts just start with no pre-selected default.
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
    yield* Effect.sync(() => mkdirSync(".ktm", { recursive: true }));
    const encoded = yield* Schema.encodeEffect(HarnessPreferences)(preferences).pipe(Effect.orDie);
    yield* Effect.tryPromise(() =>
      Bun.write(PREFERENCES_PATH, `${JSON.stringify(encoded, null, 2)}\n`),
    ).pipe(Effect.orDie);
  });
