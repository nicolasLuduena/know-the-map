import { expect, test } from "bun:test";
import type { HarnessModelOption } from "@know-the-map/harness";
import { Duration, Effect, Option } from "effect";
import { resolveHarnessSelection } from "./harness-prompt.ts";

const catalog: ReadonlyArray<HarnessModelOption> = [
  {
    providerId: "opencode-go",
    modelId: "deepseek-v4.1-flash",
    modelName: "DeepSeek V4.1 Flash",
    variants: ["low", "high"],
    limit: { context: 1, output: 1 },
  },
  {
    providerId: "openrouter",
    modelId: "google/gemini-2.5-flash",
    modelName: "Gemini",
    variants: [],
    limit: { context: 1, output: 1 },
  },
];

const resolve = (
  ref: string,
  variant?: string,
  defaults?: Parameters<typeof resolveHarnessSelection>[3],
) =>
  Effect.runPromiseExit(
    resolveHarnessSelection(
      catalog,
      ref,
      Option.fromUndefinedOr(variant),
      defaults ?? Option.none(),
    ),
  );

test("resolves provider/model with a variant and the defaults", async () => {
  const exit = await resolve("opencode-go/deepseek-v4.1-flash", "high");
  expect(exit._tag).toBe("Success");
  if (exit._tag === "Success") {
    expect(exit.value.model).toEqual({
      providerId: "opencode-go",
      modelId: "deepseek-v4.1-flash",
      variantId: "high",
    });
    expect(Duration.toMinutes(exit.value.turnTimeout)).toBe(15);
    expect(exit.value.maxGenerationTokens).toBe(32_768);
  }
});

test("splits at the first slash so a model id may contain one", async () => {
  const exit = await resolve("openrouter/google/gemini-2.5-flash");
  expect(exit._tag).toBe("Success");
  if (exit._tag === "Success") {
    expect(exit.value.model.modelId).toBe("google/gemini-2.5-flash");
    expect(exit.value.model.variantId).toBeUndefined();
  }
});

test("saved preferences supply the turn timeout and generation cap", async () => {
  const exit = await resolve(
    "opencode-go/deepseek-v4.1-flash",
    undefined,
    Option.some({
      providerId: "x",
      modelId: "y",
      turnTimeout: Duration.minutes(3),
      maxGenerationTokens: 99,
    }),
  );
  expect(exit._tag).toBe("Success");
  if (exit._tag === "Success") {
    expect(Duration.toMinutes(exit.value.turnTimeout)).toBe(3);
    expect(exit.value.maxGenerationTokens).toBe(99);
  }
});

test.each<[ref: string, variant: string | undefined, message: string]>([
  ["not-a-ref", undefined, "must be provider/model"],
  ["opencode-go/", undefined, "must be provider/model"],
  ["opencode-go/nope", undefined, 'no usable model "opencode-go/nope"'],
  ["opencode-go/deepseek-v4.1-flash", "max", 'has no variant "max"'],
])("rejects %s", async (ref, variant, message) => {
  const exit = await resolve(ref, variant);
  expect(exit._tag).toBe("Failure");
  expect(String(exit)).toContain(message);
});
