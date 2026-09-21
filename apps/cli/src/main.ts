#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Git, GitLive } from "@know-the-map/git";
import { HostFailureError } from "@know-the-map/harness";
import { startViewer } from "@know-the-map/viewer";
import { Console, Effect, Layer } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

const VERSION = "0.0.0";

const view = Command.make(
  "view",
  {
    path: Argument.string("path").pipe(
      Argument.withDescription("Directory inside the analyzed repository"),
      Argument.withDefault("."),
    ),
    artifact: Flag.string("artifact").pipe(Flag.withDescription("Saved analysis to open")),
    port: Flag.integer("port").pipe(
      Flag.withDescription("Loopback port; 0 selects an available one"),
      Flag.withDefault(0),
    ),
  },
  ({ path, artifact, port }) =>
    Effect.gen(function* () {
      const git = yield* Git;
      const viewer = yield* startViewer({ directory: path, artifactPath: artifact, port, git });
      yield* Console.log(`viewing the saved analysis at ${viewer.url}`);
      yield* Console.log("press Ctrl+C to stop");
      return yield* Effect.never;
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) => new HostFailureError({ message: cause.message, cause })),
    ),
).pipe(Command.withDescription("Browse a saved analysis in a local web interface"));

const cli = Command.make("ktm").pipe(
  Command.withDescription("Know the Map"),
  Command.withSubcommands([view]),
);

cli.pipe(
  Command.run({ version: VERSION }),
  Effect.provide(GitLive.pipe(Layer.provideMerge(BunServices.layer))),
  BunRuntime.runMain,
);
