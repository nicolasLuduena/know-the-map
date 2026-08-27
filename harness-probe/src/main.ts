import { Effect, Runtime } from "effect";
import { PiHarness } from "./pi-harness.ts";

const program = Effect.gen(function* () {
  const harness = yield* PiHarness;
  const request = {
    topic: "what-the-hunk",
    angle: "what does this repository do and how is it structured",
    maxPoints: 3,
  };
  const result = yield* harness.execute(request);
  yield* Effect.logInfo(`echoed topic: ${result.echoedTopic}`);
  yield* Effect.logInfo(`summary: ${result.summary}`);
  for (const point of result.keyPoints) {
    yield* Effect.logInfo(`- ${point.title}: ${point.detail}`);
  }
  return result;
}).pipe(
  Effect.timeout("90 seconds"),
  Effect.scoped,
  Effect.provide(PiHarness.Live),
);

Runtime.makeRunMain(({ fiber, teardown }) => {
  fiber.addObserver((exit) => {
    teardown(exit, (code) => process.exit(code));
  });
})(program);