import { expect, test } from "bun:test";
import { HostFailureError } from "@know-the-map/harness";
import { Effect, Layer } from "effect";
import { defaultOpencodeHarnessConfig, type OpencodeHarnessConfig } from "./opencode-config.ts";
import { layerFromConfig } from "./opencode-harness.ts";

/**
 * Both guards below run before any I/O (env, filesystem, `OpenCode.create`)
 * in `layerFromConfig`, so building the layer is enough to observe them —
 * no API key or embedded host is ever touched.
 */
const buildFails = (config: OpencodeHarnessConfig) =>
  Effect.runPromise(Effect.flip(Effect.scoped(Layer.build(layerFromConfig(config)))));

test("layerFromConfig rejects a non-empty mcpServers map", async () => {
  const failure = await buildFails({
    ...defaultOpencodeHarnessConfig,
    mcpServers: { example: { type: "local", command: ["echo"] } },
  });

  expect(failure).toBeInstanceOf(HostFailureError);
  expect(failure._tag).toBe("HostFailureError");
  expect(failure.message).toContain("MCP servers are not yet supported");
});

test("layerFromConfig rejects a model outside the fixed catalog", async () => {
  const failure = await buildFails({
    ...defaultOpencodeHarnessConfig,
    model: "opencode-go/some-other-model",
  });

  expect(failure).toBeInstanceOf(HostFailureError);
  expect(failure._tag).toBe("HostFailureError");
  expect(failure.message).toContain('unknown model "opencode-go/some-other-model"');
});
