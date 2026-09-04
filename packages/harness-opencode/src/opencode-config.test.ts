import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, ConfigProvider, Duration, Effect } from "effect";
import {
  buildCreateOptions,
  buildHostConfig,
  loadOpencodeHarnessConfig,
  type OpencodeHarnessConfig,
  resolveOpenCodeGoApiKey,
  SUPPORTED_MODEL,
} from "./opencode-config.ts";

const TEST_CONFIG: OpencodeHarnessConfig = {
  model: SUPPORTED_MODEL,
  turnTimeout: Duration.minutes(15),
  maxGenerationTokens: 32_768,
  scratchDirectory: "/tmp/what-the-hunk-test/opencode",
  mcpServers: {},
};

const REQUIRED_ENV: Record<string, string> = {
  KTM_OPENCODE_MODEL: TEST_CONFIG.model,
  KTM_OPENCODE_TURN_TIMEOUT: "15 minutes",
  KTM_OPENCODE_MAX_GENERATION_TOKENS: String(TEST_CONFIG.maxGenerationTokens),
  KTM_OPENCODE_SCRATCH_DIRECTORY: TEST_CONFIG.scratchDirectory,
};

const loadWithEnv = (env: Record<string, string>) =>
  Effect.runPromise(
    loadOpencodeHarnessConfig.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
    ),
  );

test("loadOpencodeHarnessConfig resolves every field from its env var", async () => {
  const config = await loadWithEnv(REQUIRED_ENV);
  expect(config.model).toBe(TEST_CONFIG.model);
  expect(Duration.toMillis(config.turnTimeout)).toBe(Duration.toMillis(TEST_CONFIG.turnTimeout));
  expect(config.maxGenerationTokens).toBe(TEST_CONFIG.maxGenerationTokens);
  expect(config.scratchDirectory).toBe(TEST_CONFIG.scratchDirectory);
  expect(config.mcpServers).toEqual({});
});

test("loadOpencodeHarnessConfig has no fallback: a missing env var fails loudly", async () => {
  const { KTM_OPENCODE_MODEL: _omitted, ...incomplete } = REQUIRED_ENV;
  const failure = await Effect.runPromise(
    Effect.flip(
      loadOpencodeHarnessConfig.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(incomplete))),
      ),
    ),
  );
  expect(failure).toBeInstanceOf(Config.ConfigError);
});

test("buildHostConfig threads the model selection and MCP servers into the host policy", () => {
  const host = buildHostConfig({
    ...TEST_CONFIG,
    mcpServers: { example: { type: "local", command: ["echo"] } },
  });
  expect(host.mcp).toEqual({ servers: { example: { type: "local", command: ["echo"] } } });
  expect(host.provider["opencode-go"].models).toHaveProperty("deepseek-v4-flash");
});

test("buildCreateOptions scopes the scratch directory and embeds the host config", () => {
  const options = buildCreateOptions({ ...TEST_CONFIG, scratchDirectory: "/tmp/custom-scratch" });
  expect(options.config.directory).toBe("/tmp/custom-scratch");
  expect(options.config.project).toBe(false);
  expect(JSON.parse(options.config.content)).toEqual(
    buildHostConfig({ ...TEST_CONFIG, scratchDirectory: "/tmp/custom-scratch" }),
  );
});

test("resolveOpenCodeGoApiKey returns undefined when HOME is unset", async () => {
  const previous = process.env["HOME"];
  delete process.env["HOME"];
  try {
    const key = await Effect.runPromise(resolveOpenCodeGoApiKey);
    expect(key).toBeUndefined();
  } finally {
    if (previous === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = previous;
    }
  }
});

test("resolveOpenCodeGoApiKey returns undefined when the auth file is missing or malformed", async () => {
  const previous = process.env["HOME"];
  const home = mkdtempSync(join(tmpdir(), "ktm-opencode-auth-"));
  process.env["HOME"] = home;
  try {
    // No auth.json at all yet.
    expect(await Effect.runPromise(resolveOpenCodeGoApiKey)).toBeUndefined();

    // Present but not valid JSON.
    const authDir = join(home, ".local/share/opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), "not json");
    expect(await Effect.runPromise(resolveOpenCodeGoApiKey)).toBeUndefined();

    // Valid JSON, but no opencode-go entry.
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({ "other-provider": { key: "x" } }));
    expect(await Effect.runPromise(resolveOpenCodeGoApiKey)).toBeUndefined();
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (previous === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = previous;
    }
  }
});
