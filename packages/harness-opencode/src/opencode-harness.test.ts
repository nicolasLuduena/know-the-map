import { expect, test } from "bun:test";
import { HostFailureError } from "@know-the-map/harness";
import { Duration, Effect, Layer } from "effect";
import { type OpencodeHarnessConfig, SUPPORTED_MODEL } from "./opencode-config.ts";
import { layerFromConfig } from "./opencode-harness.ts";

const TEST_CONFIG: OpencodeHarnessConfig = {
  model: SUPPORTED_MODEL,
  turnTimeout: Duration.minutes(15),
  maxGenerationTokens: 32_768,
  scratchDirectory: "/tmp/what-the-hunk-test/opencode",
  mcpServers: {},
};

/**
 * Both guards below run before any I/O (env, filesystem, `OpenCode.create`)
 * in `layerFromConfig`, so building the layer is enough to observe them —
 * no API key or embedded host is ever touched.
 */
const buildFails = (config: OpencodeHarnessConfig) =>
  Effect.runPromise(Effect.flip(Effect.scoped(Layer.build(layerFromConfig(config)))));

test("layerFromConfig rejects a non-empty mcpServers map", async () => {
  const failure = await buildFails({
    ...TEST_CONFIG,
    mcpServers: { example: { type: "local", command: ["echo"] } },
  });

  expect(failure).toBeInstanceOf(HostFailureError);
  expect(failure._tag).toBe("HostFailureError");
  expect(failure.message).toContain("MCP servers are not yet supported");
});

test("layerFromConfig rejects a model outside the fixed catalog", async () => {
  const failure = await buildFails({ ...TEST_CONFIG, model: "opencode-go/some-other-model" });

  expect(failure).toBeInstanceOf(HostFailureError);
  expect(failure._tag).toBe("HostFailureError");
  expect(failure.message).toContain('unknown model "opencode-go/some-other-model"');
});
