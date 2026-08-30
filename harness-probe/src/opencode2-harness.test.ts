import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { DEFAULT_MODEL, SupportedModel } from "./opencode2-harness.ts";

describe("OpenCode2 model selection", () => {
  test("defaults to DeepSeek V4 Flash", () => {
    expect(DEFAULT_MODEL).toBe("opencode-go/deepseek-v4-flash");
  });

  test("accepts only the two supported OpenCode Go models", () => {
    const isSupported = Schema.is(SupportedModel);

    expect(isSupported("opencode-go/deepseek-v4-flash")).toBe(true);
    expect(isSupported("opencode-go/glm-5.3-flash")).toBe(true);
    expect(isSupported("other/model")).toBe(false);
  });
});
