import { expect, test } from "bun:test";
import { Effect } from "effect";
import { NotImplementedError } from "./errors.ts";
import { Harness, HarnessStub } from "./harness.ts";

test("stub harness fails with NotImplementedError", async () => {
  const program = Effect.gen(function* () {
    const harness = yield* Harness;
    return yield* harness.start({ systemPrompt: "test" });
  }).pipe(Effect.provide(HarnessStub));

  const failure = await Effect.runPromise(Effect.flip(program)).then(
    (error) => error,
    () => undefined,
  );

  expect(failure).toBeInstanceOf(NotImplementedError);
  expect(failure?._tag).toBe("NotImplementedError");
});
