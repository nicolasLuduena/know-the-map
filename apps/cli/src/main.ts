#!/usr/bin/env bun
import { OpencodeHarnessLive } from "@know-the-map/harness-opencode";
import { PiHarnessLive } from "@know-the-map/harness-pi";
import { Hermeneut, HermeneutStub } from "@know-the-map/hermeneut";
import { Effect } from "effect";

const VERSION = "0.0.0";

const HELP = `ktm — Know the Map

Usage: ktm [command]

Commands:
  run  Start the interpretation loop (not implemented yet)

Options:
  -h, --help     Print help
  -v, --version  Print version
`;

const program = Effect.gen(function* () {
  const hermeneut = yield* Hermeneut;
  yield* hermeneut.run();
}).pipe(
  Effect.provide([HermeneutStub, OpencodeHarnessLive, PiHarnessLive]),
  Effect.as(0),
  Effect.catchTag("NotImplementedError", (error) =>
    Effect.sync(() => {
      console.error(`ktm: ${error.message}`);
      return 1;
    }),
  ),
  Effect.catch((error) =>
    Effect.sync(() => {
      console.error("ktm: unexpected failure", error);
      return 1;
    }),
  ),
);

async function main(): Promise<number> {
  const args = Bun.argv.slice(2);

  if (args.includes("-v") || args.includes("--version")) {
    console.log(VERSION);
    return 0;
  }
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    console.log(HELP);
    return 0;
  }

  const command = args.at(0);
  if (command === undefined) {
    console.log(HELP);
    return 0;
  }
  switch (command) {
    case "run": {
      return await Effect.runPromise(program);
    }
    default: {
      console.error(`ktm: unknown command "${command}"`);
      console.log(HELP);
      return 1;
    }
  }
}

process.exit(await main());
