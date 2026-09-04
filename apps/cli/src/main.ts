#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { GitLive } from "@know-the-map/git";
import { guard, Harness, HostFailureError } from "@know-the-map/harness";
import { OpencodeHarnessLive } from "@know-the-map/harness-opencode";
import { defaultAnalysisBounds, Hermeneut, HermeneutLive } from "@know-the-map/hermeneut";
import { Config, Console, Effect, Layer } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { readHarnessPreferences, writeHarnessPreferences } from "./harness-preferences.ts";
import { promptHarnessSelection } from "./harness-prompt.ts";

const VERSION = "0.0.0";
const OUTPUT_PATH = join(".ktm", "analysis.json");

const analyze = Command.make(
  "analyze",
  {
    path: Argument.string("path").pipe(
      Argument.withDescription("Directory inside the repository to analyze"),
      Argument.withDefault("."),
    ),
    maxHarnessCalls: Flag.integer("max-harness-calls").pipe(
      Flag.withDescription("Maximum model calls before the run stops"),
      Flag.withFallbackConfig(Config.int("KTM_MAX_HARNESS_CALLS")),
      Flag.withDefault(defaultAnalysisBounds.maxHarnessCalls),
    ),
    maxDepth: Flag.integer("max-depth").pipe(
      Flag.withDescription("Maximum component-division depth before the run stops"),
      Flag.withFallbackConfig(Config.int("KTM_MAX_DEPTH")),
      Flag.withDefault(defaultAnalysisBounds.maxDepth),
    ),
    maxClarifications: Flag.integer("max-clarifications").pipe(
      Flag.withDescription("Maximum clarification rounds per model exchange"),
      Flag.withFallbackConfig(Config.int("KTM_MAX_CLARIFICATIONS")),
      Flag.withDefault(defaultAnalysisBounds.maxClarifications),
    ),
  },
  ({ path, maxHarnessCalls, maxDepth, maxClarifications }) =>
    Effect.gen(function* () {
      const harness = yield* Harness;
      const hermeneut = yield* Hermeneut;

      const options = yield* harness.listModels();
      yield* guard(
        options.length > 0,
        () =>
          new HostFailureError({
            message: "no usable provider found — check ~/.local/share/opencode/auth.json",
          }),
      );
      const defaults = yield* readHarnessPreferences;
      const selection = yield* promptHarnessSelection(options, defaults).pipe(
        Effect.mapError((cause) => new HostFailureError({ message: "prompt cancelled", cause })),
      );
      yield* writeHarnessPreferences(selection.preferences);

      const artifact = yield* hermeneut.analyze(path, selection.harness, {
        maxHarnessCalls,
        maxDepth,
        maxClarifications,
      });
      yield* Effect.sync(() => mkdirSync(".ktm", { recursive: true }));
      yield* Effect.tryPromise(() =>
        Bun.write(OUTPUT_PATH, `${JSON.stringify(artifact, null, 2)}\n`),
      ).pipe(Effect.orDie);
      yield* Console.log(`components: ${artifact.components.length}`);
      yield* Console.log(`relationships: ${artifact.relationships.length}`);
      yield* Console.log(`interpretations: ${artifact.interpretations.length}`);
      yield* Console.log(`wrote ${OUTPUT_PATH} (head ${artifact.headCommit})`);
    }),
).pipe(Command.withDescription("Analyze a repository, writing .ktm/analysis.json"));

const cli = Command.make("ktm").pipe(
  Command.withDescription("Know the Map"),
  Command.withSubcommands([analyze]),
);

cli.pipe(
  Command.run({ version: VERSION }),
  Effect.provide(
    Layer.mergeAll(
      HermeneutLive.pipe(
        Layer.provide(Layer.provide(GitLive, BunServices.layer)),
        Layer.provide(OpencodeHarnessLive),
      ),
      OpencodeHarnessLive,
    ).pipe(Layer.provideMerge(BunServices.layer)),
  ),
  BunRuntime.runMain,
);
