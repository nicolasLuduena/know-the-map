import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { layout } from "@know-the-map/store";
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
const preferencesPath = (home: string): string => layout(home).harnessPreferences("opencode");

/**
 * A missing or malformed `$KTM_HOME/harness/opencode.json` is "no saved
 * preferences", never a failure — the prompts just start with no
 * pre-selected default.
 */
export const readHarnessPreferences = (
  home: string,
): Effect.Effect<Option.Option<HarnessPreferences>> =>
  Effect.gen(function* () {
    const contents = yield* Effect.tryPromise({
      try: () => Bun.file(preferencesPath(home)).json(),
      catch: (cause) => cause,
    }).pipe(Effect.option);
    if (Option.isNone(contents)) {
      return Option.none();
    }
    return Schema.decodeUnknownOption(HarnessPreferences)(contents.value);
  });

export const writeHarnessPreferences = (
  home: string,
  preferences: HarnessPreferences,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const path = preferencesPath(home);
    yield* Effect.sync(() => mkdirSync(dirname(path), { recursive: true }));
    const encoded = yield* Schema.encodeEffect(HarnessPreferences)(preferences).pipe(Effect.orDie);
    yield* Effect.tryPromise(() => Bun.write(path, `${JSON.stringify(encoded, null, 2)}\n`)).pipe(
      Effect.orDie,
    );
  });
