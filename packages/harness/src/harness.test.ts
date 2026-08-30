import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Harness, HarnessStub } from "./harness.ts";
import { NotImplementedError } from "./errors.ts";

test("stub harness fails with NotImplementedError", async () => {
  const program = Effect.gen(function*() {
    const harness = yield* Harness;
    return yield* harness.execute({});
  }).pipe(Effect.provide(HarnessStub));

  const failure = await Effect.runPromise(Effect.flip(program)).then(
    (error) => error,
    () => undefined,
  );

  expect(failure).toBeInstanceOf(NotImplementedError);
  expect(failure?._tag).toBe("NotImplementedError");
});
