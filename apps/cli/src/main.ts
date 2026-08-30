#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { OpencodeHarnessLive } from "@know-the-map/harness-opencode";
import { PiHarnessLive } from "@know-the-map/harness-pi";
import { Hermeneut, HermeneutStub } from "@know-the-map/hermeneut";
import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";

const VERSION = "0.0.0";

const run = Command.make("run", {}, () =>
  Effect.gen(function* () {
    const hermeneut = yield* Hermeneut;
    yield* hermeneut.run();
  }),
).pipe(Command.withDescription("Start the interpretation loop"));

const cli = Command.make("ktm").pipe(
  Command.withDescription("Know the Map"),
  Command.withSubcommands([run]),
);

const hermeneutLayers = Layer.mergeAll(HermeneutStub, OpencodeHarnessLive, PiHarnessLive);

cli.pipe(
  Command.run({ version: VERSION }),
  Effect.provide([BunServices.layer, hermeneutLayers]),
  BunRuntime.runMain,
);
