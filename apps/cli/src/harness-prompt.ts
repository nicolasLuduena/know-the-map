import type { HarnessModelOption } from "@know-the-map/harness";
import type { HarnessSelection } from "@know-the-map/hermeneut";
import { Console, Duration, Effect, Option, type Terminal } from "effect";
import { Prompt } from "effect/unstable/cli";
import type { HarnessPreferences } from "./harness-preferences.ts";

const DEFAULT_TURN_TIMEOUT_MINUTES = 15;
const DEFAULT_MAX_GENERATION_TOKENS = 32_768;

/**
 * Walks the user through provider → model → reasoning/variant, shows the
 * resulting limits, then asks for a turn timeout and generation cap. Every
 * step's default comes from `defaults` (the last saved choice) when it's
 * still present among the live `options` — a saved pick that's since
 * disappeared from the catalog is never offered as pre-selected.
 */
export const promptHarnessSelection = (
  options: ReadonlyArray<HarnessModelOption>,
  defaults: Option.Option<HarnessPreferences>,
): Effect.Effect<
  { readonly harness: HarnessSelection; readonly preferences: HarnessPreferences },
  Terminal.QuitError,
  Prompt.Environment
> =>
  Effect.gen(function* () {
    const previous = Option.getOrUndefined(defaults);

    const providerIds = [...new Set(options.map((option) => option.providerId))];
    const providerId = yield* Prompt.run(
      Prompt.select({
        message: "Provider",
        choices: providerIds.map((id) => ({
          title: id,
          value: id,
          selected: id === previous?.providerId,
        })),
      }),
    );

    const modelsForProvider = options.filter((option) => option.providerId === providerId);
    const modelId = yield* Prompt.run(
      Prompt.select({
        message: "Model",
        choices: modelsForProvider.map((option) => ({
          title: option.modelName,
          value: option.modelId,
          selected: option.modelId === previous?.modelId,
        })),
      }),
    );
    const model = modelsForProvider.find((option) => option.modelId === modelId);
    if (model === undefined) {
      return yield* Effect.die(new Error("selected model vanished from its own option list"));
    }

    const variantId =
      model.variants.length === 0
        ? undefined
        : yield* Prompt.run(
            Prompt.select({
              message: "Reasoning / variant",
              choices: model.variants.map((variant) => ({
                title: variant,
                value: variant,
                selected: variant === previous?.variantId,
              })),
            }),
          );

    const costLine =
      model.cost === undefined || model.cost.length === 0
        ? ""
        : ` · cost: $${model.cost[0]?.input}/$${model.cost[0]?.output} per million tokens (in/out)`;
    yield* Console.log(
      `limits — context: ${model.limit.context.toLocaleString()} tokens, output: ${model.limit.output.toLocaleString()} tokens${costLine}`,
    );

    const turnTimeoutMinutes = yield* Prompt.run(
      Prompt.integer({
        message: "Turn timeout, in minutes",
        default:
          previous === undefined
            ? DEFAULT_TURN_TIMEOUT_MINUTES
            : Duration.toMinutes(previous.turnTimeout),
        min: 1,
      }),
    );

    const maxGenerationTokens = yield* Prompt.run(
      Prompt.integer({
        message: "Max generation tokens",
        default: previous?.maxGenerationTokens ?? DEFAULT_MAX_GENERATION_TOKENS,
        min: 1,
      }),
    );

    const preferences: HarnessPreferences = {
      providerId,
      modelId,
      variantId,
      turnTimeout: Duration.minutes(turnTimeoutMinutes),
      maxGenerationTokens,
    };

    return {
      harness: {
        model: { providerId, modelId, variantId },
        turnTimeout: preferences.turnTimeout,
        maxGenerationTokens,
      },
      preferences,
    };
  });
