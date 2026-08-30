import { Effect, Runtime } from "effect";
import { Opencode2Harness } from "./opencode2-harness.ts";

const program = Effect.gen(function* () {
  const harness = yield* Opencode2Harness;
  const request = {
    topic: "structured transport",
    angle: "confirm that a typed request can make a round trip",
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
  Effect.timeout("120 seconds"),
  Effect.scoped,
  Effect.provide(Opencode2Harness.Live),
);

Runtime.makeRunMain(({ fiber, teardown }) => {
  fiber.addObserver((exit) => {
    teardown(exit, (code) => process.exit(code));
  });
})(program);
