import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigProvider, Duration, Effect } from "effect";
import {
  buildCreateOptions,
  buildHostConfig,
  defaultOpencodeHarnessConfig,
  loadOpencodeHarnessConfig,
  resolveOpenCodeGoApiKey,
} from "./opencode-config.ts";

const loadWithEnv = (env: Record<string, string>) =>
  Effect.runPromise(
    loadOpencodeHarnessConfig.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
    ),
  );

test("loadOpencodeHarnessConfig resolves the defaults against an empty environment", async () => {
  const config = await loadWithEnv({});
  expect(config).toEqual(defaultOpencodeHarnessConfig);
});

test("loadOpencodeHarnessConfig picks up KTM_OPENCODE_MODEL", async () => {
  const config = await loadWithEnv({ KTM_OPENCODE_MODEL: "opencode-go/other-model" });
  expect(config.model).toBe("opencode-go/other-model");
});

test("loadOpencodeHarnessConfig picks up KTM_OPENCODE_TURN_TIMEOUT", async () => {
  const config = await loadWithEnv({ KTM_OPENCODE_TURN_TIMEOUT: "5 minutes" });
  expect(Duration.toMillis(config.turnTimeout)).toBe(Duration.toMillis(Duration.minutes(5)));
});

test("loadOpencodeHarnessConfig picks up KTM_OPENCODE_MAX_GENERATION_TOKENS", async () => {
  const config = await loadWithEnv({ KTM_OPENCODE_MAX_GENERATION_TOKENS: "1024" });
  expect(config.maxGenerationTokens).toBe(1024);
});

test("loadOpencodeHarnessConfig picks up KTM_OPENCODE_SCRATCH_DIRECTORY", async () => {
  const config = await loadWithEnv({ KTM_OPENCODE_SCRATCH_DIRECTORY: "/tmp/somewhere-else" });
  expect(config.scratchDirectory).toBe("/tmp/somewhere-else");
});

test("buildHostConfig threads the model selection and MCP servers into the host policy", () => {
  const host = buildHostConfig({
    ...defaultOpencodeHarnessConfig,
    mcpServers: { example: { type: "local", command: ["echo"] } },
  });
  expect(host.mcp).toEqual({ servers: { example: { type: "local", command: ["echo"] } } });
  expect(host.provider["opencode-go"].models).toHaveProperty("deepseek-v4-flash");
});

test("buildCreateOptions scopes the scratch directory and embeds the host config", () => {
  const options = buildCreateOptions({
    ...defaultOpencodeHarnessConfig,
    scratchDirectory: "/tmp/custom-scratch",
  });
  expect(options.config.directory).toBe("/tmp/custom-scratch");
  expect(options.config.project).toBe(false);
  expect(JSON.parse(options.config.content)).toEqual(
    buildHostConfig({ ...defaultOpencodeHarnessConfig, scratchDirectory: "/tmp/custom-scratch" }),
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
