#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Git, GitLive } from "@know-the-map/git";
import { guard, Harness, HostFailureError } from "@know-the-map/harness";
import { OpencodeHarnessLive } from "@know-the-map/harness-opencode";
import {
  AnalysisArtifact,
  defaultAnalysisBounds,
  Hermeneut,
  HermeneutLive,
} from "@know-the-map/hermeneut";
import { startViewer } from "@know-the-map/viewer";
import { Config, Console, Effect, Layer, Schema } from "effect";
import { Argument, Command, Flag, Prompt } from "effect/unstable/cli";
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
    maxClarifications: Flag.integer("max-clarifications").pipe(
      Flag.withDescription("Maximum clarification rounds per model exchange"),
      Flag.withFallbackConfig(Config.int("KTM_MAX_CLARIFICATIONS")),
      Flag.withDefault(defaultAnalysisBounds.maxClarifications),
    ),
  },
  ({ path, maxHarnessCalls, maxClarifications }) =>
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

      // Interactive like the harness selection above, for the same reason:
      // a division-depth cap the caller can't see or tune per run is a
      // silent tradeoff. Not persisted to .ktm/harness/opencode.json — that
      // file is harness-selection state, not an analysis bound.
      const maxDepth = yield* Prompt.run(
        Prompt.integer({
          message: "Max component-division depth",
          default: defaultAnalysisBounds.maxDepth,
          min: 1,
        }),
      ).pipe(
        Effect.mapError((cause) => new HostFailureError({ message: "prompt cancelled", cause })),
      );

      const artifact = yield* hermeneut.analyze(path, selection.harness, {
        maxHarnessCalls,
        maxDepth,
        maxClarifications,
      });
      yield* Effect.sync(() => mkdirSync(".ktm", { recursive: true }));
      const encoded = yield* Schema.encodeEffect(AnalysisArtifact)(artifact).pipe(Effect.orDie);
      yield* Effect.tryPromise(() =>
        Bun.write(OUTPUT_PATH, `${JSON.stringify(encoded, null, 2)}\n`),
      ).pipe(Effect.orDie);
      yield* Console.log(`components: ${artifact.components.length}`);
      yield* Console.log(`relationships: ${artifact.relationships.length}`);
      yield* Console.log(`interpretations: ${artifact.interpretations.length}`);
      yield* Console.log(`wrote ${OUTPUT_PATH} (head ${artifact.headCommit})`);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          HermeneutLive.pipe(Layer.provide(GitLive), Layer.provide(OpencodeHarnessLive)),
          OpencodeHarnessLive,
        ),
      ),
    ),
).pipe(Command.withDescription("Analyze a repository, writing .ktm/analysis.json"));

const view = Command.make(
  "view",
  {
    path: Argument.string("path").pipe(
      Argument.withDescription("Directory inside the analyzed repository"),
      Argument.withDefault("."),
    ),
    artifact: Flag.string("artifact").pipe(
      Flag.withDescription("Saved analysis artifact to open"),
      Flag.withDefault(OUTPUT_PATH),
    ),
    port: Flag.integer("port").pipe(
      Flag.withDescription("Loopback port; 0 selects an available port"),
      Flag.withDefault(0),
    ),
  },
  ({ path, artifact, port }) =>
    Effect.gen(function* () {
      const git = yield* Git;
      return yield* Effect.acquireUseRelease(
        startViewer({ directory: path, artifactPath: artifact, port, git }).pipe(
          Effect.mapError((cause) => new HostFailureError({ message: cause.message, cause })),
        ),
        (viewer) =>
          Console.log(`view saved analysis at ${viewer.url}`).pipe(Effect.andThen(Effect.never)),
        (viewer) => Effect.sync(viewer.stop),
      );
    }),
).pipe(Command.withDescription("Browse a saved analysis in a local web interface"));

const cli = Command.make("ktm").pipe(
  Command.withDescription("Know the Map"),
  Command.withSubcommands([analyze, view]),
);

cli.pipe(
  Command.run({ version: VERSION }),
  Effect.provide(GitLive.pipe(Layer.provideMerge(BunServices.layer))),
  BunRuntime.runMain,
);
