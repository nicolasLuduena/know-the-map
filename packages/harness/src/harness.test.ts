import { expect, test } from "bun:test";
import { Duration, Effect } from "effect";
import { NotImplementedError } from "./errors.ts";
import { guard } from "./guard.ts";
import { Harness, HarnessStub } from "./harness.ts";

test("stub harness fails with NotImplementedError", async () => {
  const program = Effect.gen(function* () {
    const harness = yield* Harness;
    return yield* harness.start({
      directory: "/tmp",
      systemPrompt: "test",
      model: { providerId: "opencode-go", modelId: "deepseek-v4-flash" },
      turnTimeout: Duration.minutes(15),
      maxGenerationTokens: 32_768,
    });
  }).pipe(Effect.provide(HarnessStub));

  const failure = await Effect.runPromise(Effect.flip(program)).then(
    (error) => error,
    () => undefined,
  );

  expect(failure).toBeInstanceOf(NotImplementedError);
  expect(failure?._tag).toBe("NotImplementedError");
});

test("stub harness's listModels fails with NotImplementedError", async () => {
  const program = Effect.gen(function* () {
    const harness = yield* Harness;
    return yield* harness.listModels();
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
