import { expect, test } from "bun:test";
import { Effect } from "effect";
import { NotImplementedError } from "./errors.ts";
import { guard } from "./guard.ts";
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

test("guard passes silently, fails lazily with the given error", async () => {
  let built = 0;
  const passing = guard(true, () => {
    built++;
    return new NotImplementedError({ message: "unreachable" });
  });
  const failing = guard(false, () => new NotImplementedError({ message: "guarded" }));

  await Effect.runPromise(passing);
  expect(built).toBe(0);
  const error = await Effect.runPromise(Effect.flip(failing));
  expect(error).toBeInstanceOf(NotImplementedError);
});
