#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { GitLive } from "@know-the-map/git";
import { OpencodeHarnessLive } from "@know-the-map/harness-opencode";
import { Hermeneut, HermeneutLive } from "@know-the-map/hermeneut";
import { Console, Effect, Layer } from "effect";
import { Argument, Command } from "effect/unstable/cli";

const VERSION = "0.0.0";
const OUTPUT_PATH = join(".ktm", "analysis.json");

const analyze = Command.make(
  "analyze",
  {
    path: Argument.string("path").pipe(
      Argument.withDescription("Directory inside the repository to analyze"),
      Argument.withDefault("."),
    ),
  },
  ({ path }) =>
    Effect.gen(function* () {
      const hermeneut = yield* Hermeneut;
      const artifact = yield* hermeneut.analyze(path);
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
    HermeneutLive.pipe(
      Layer.provide(Layer.provide(GitLive, BunServices.layer)),
      Layer.provide(OpencodeHarnessLive),
      Layer.provideMerge(BunServices.layer),
    ),
  ),
  BunRuntime.runMain,
);
