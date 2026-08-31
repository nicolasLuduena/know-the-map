#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { GitLive } from "@know-the-map/git";
import { OpencodeHarnessLive } from "@know-the-map/harness-opencode";
import { AnalysisArtifact, Hermeneut, HermeneutLive } from "@know-the-map/hermeneut";
import { Console, Effect, Layer, Schema } from "effect";
import { Command } from "effect/unstable/cli";
import { renderVizHtml, VIZ_OUTPUT_PATH } from "./viz.ts";

const VERSION = "0.0.0";
const OUTPUT_PATH = join(".ktm", "analysis.json");

const analyze = Command.make("analyze", {}, () =>
  Effect.gen(function* () {
    const hermeneut = yield* Hermeneut;
    const artifact = yield* hermeneut.analyze();
    yield* Effect.sync(() => mkdirSync(".ktm", { recursive: true }));
    yield* Effect.tryPromise(() =>
      Bun.write(OUTPUT_PATH, `${JSON.stringify(artifact, null, 2)}\n`),
    ).pipe(Effect.orDie);
    yield* Console.log(`components: ${artifact.components.length}`);
    yield* Console.log(`relationships: ${artifact.relationships.length}`);
    yield* Console.log(`interpretations: ${artifact.interpretations.length}`);
    yield* Console.log(`wrote ${OUTPUT_PATH} (head ${artifact.headCommit})`);
  }),
).pipe(Command.withDescription("Analyze the repository in the current directory"));

const viz = Command.make("viz", {}, () =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(
      () => Bun.file(OUTPUT_PATH).json() as Promise<unknown>,
    ).pipe(Effect.orDie);
    const artifact = yield* Schema.decodeUnknownEffect(AnalysisArtifact)(raw).pipe(Effect.orDie);
    yield* Effect.tryPromise(() => Bun.write(VIZ_OUTPUT_PATH, renderVizHtml(artifact))).pipe(
      Effect.orDie,
    );
    yield* Console.log(
      `wrote ${VIZ_OUTPUT_PATH} (${artifact.components.length} components, ${
        artifact.relationships.length
      } relationships)`,
    );
  }),
).pipe(Command.withDescription("Render the analysis artifact as a graph view (open in a browser)"));

const cli = Command.make("ktm").pipe(
  Command.withDescription("Know the Map"),
  Command.withSubcommands([analyze, viz]),
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
