import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import {
  buildCreateOptions,
  buildHostConfig,
  listUsableProviderIds,
  PROVIDER_ENV_VARS,
  resolveApiKey,
} from "./opencode-config.ts";

/** Points HOME at a fresh temp dir, optionally seeded with an auth.json. */
const withAuthHome = async (
  entries: Record<string, unknown> | undefined,
  run: () => Promise<void>,
) => {
  const previous = process.env["HOME"];
  const home = mkdtempSync(join(tmpdir(), "ktm-opencode-auth-"));
  process.env["HOME"] = home;
  try {
    if (entries !== undefined) {
      const authDir = join(home, ".local/share/opencode");
      mkdirSync(authDir, { recursive: true });
      writeFileSync(join(authDir, "auth.json"), JSON.stringify(entries));
    }
    await run();
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (previous === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = previous;
    }
  }
};

test("buildHostConfig has no provider block — relies on opencode's own bundled catalog", () => {
  const host = buildHostConfig();
  expect(host).not.toHaveProperty("provider");
  expect(host.mcp).toEqual({ servers: {} });
  expect(host.$schema).toBe("https://opencode.ai/config.json");
});

test("buildCreateOptions scopes the scratch directory and embeds the host config", () => {
  const options = buildCreateOptions("/tmp/custom-scratch");
  expect(options.config.directory).toBe("/tmp/custom-scratch");
  expect(options.config.project).toBe(false);
  expect(JSON.parse(options.config.content)).toEqual(buildHostConfig());
});

test("PROVIDER_ENV_VARS covers opencode-go and openrouter with their real env var names", () => {
  expect(PROVIDER_ENV_VARS["opencode-go"]).toBe("OPENCODE_API_KEY");
  expect(PROVIDER_ENV_VARS["openrouter"]).toBe("OPENROUTER_API_KEY");
});

test("resolveApiKey returns undefined when HOME is unset", async () => {
  const previous = process.env["HOME"];
  delete process.env["HOME"];
  try {
    expect(await Effect.runPromise(resolveApiKey("opencode-go"))).toBeUndefined();
  } finally {
    if (previous === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = previous;
    }
  }
});

test("resolveApiKey returns undefined when the auth file is missing", async () => {
  await withAuthHome(undefined, async () => {
    expect(await Effect.runPromise(resolveApiKey("opencode-go"))).toBeUndefined();
  });
});

test("resolveApiKey returns undefined when the auth file is malformed JSON", async () => {
  const previous = process.env["HOME"];
  const home = mkdtempSync(join(tmpdir(), "ktm-opencode-auth-"));
  process.env["HOME"] = home;
  try {
    const authDir = join(home, ".local/share/opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), "not json");
    expect(await Effect.runPromise(resolveApiKey("opencode-go"))).toBeUndefined();
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (previous === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = previous;
    }
  }
});

test("resolveApiKey fails loudly when auth.json exists but isn't readable", async () => {
  const previous = process.env["HOME"];
  const home = mkdtempSync(join(tmpdir(), "ktm-opencode-auth-"));
  process.env["HOME"] = home;
  const authDir = join(home, ".local/share/opencode");
  mkdirSync(authDir, { recursive: true });
  const authFile = join(authDir, "auth.json");
  writeFileSync(authFile, JSON.stringify({ "opencode-go": { type: "api", key: "x" } }));
  chmodSync(authFile, 0o000);
  try {
    const exit = await Effect.runPromiseExit(resolveApiKey("opencode-go"));
    expect(Exit.isFailure(exit)).toBe(true);
  } finally {
    chmodSync(authFile, 0o600);
    rmSync(home, { recursive: true, force: true });
    if (previous === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = previous;
    }
  }
});

test("resolveApiKey returns undefined for an entry with a non-api type", async () => {
  await withAuthHome({ "opencode-go": { type: "oauth", access: "x" } }, async () => {
    expect(await Effect.runPromise(resolveApiKey("opencode-go"))).toBeUndefined();
  });
});

test("resolveApiKey returns the key for a valid api-type entry", async () => {
  await withAuthHome({ "opencode-go": { type: "api", key: "secret" } }, async () => {
    expect(await Effect.runPromise(resolveApiKey("opencode-go"))).toBe("secret");
  });
});

test("listUsableProviderIds excludes a provider id absent from PROVIDER_ENV_VARS", async () => {
  await withAuthHome(
    {
      "opencode-go": { type: "api", key: "a" },
      "some-other-provider": { type: "api", key: "b" },
    },
    async () => {
      const ids = await Effect.runPromise(listUsableProviderIds);
      expect(ids).toContain("opencode-go");
      expect(ids).not.toContain("some-other-provider");
    },
  );
});

test("listUsableProviderIds excludes a non-api type entry even for a mapped provider", async () => {
  await withAuthHome({ openrouter: { type: "oauth", access: "x" } }, async () => {
    const ids = await Effect.runPromise(listUsableProviderIds);
    expect(ids).not.toContain("openrouter");
  });
});

test("listUsableProviderIds is empty with no auth file", async () => {
  await withAuthHome(undefined, async () => {
    const ids = await Effect.runPromise(listUsableProviderIds);
    expect(ids).toEqual([]);
  });
});
