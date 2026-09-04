import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer, Scope } from "effect";
import { OpencodeHarnessLive } from "./opencode-harness.ts";

const withAuthHome = async (
  entries: Record<string, unknown> | undefined,
  run: () => Promise<void>,
) => {
  const previous = process.env["HOME"];
  const home = mkdtempSync(join(tmpdir(), "ktm-opencode-harness-test-"));
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

test("OpencodeHarnessLive boots with zero usable providers in auth.json", async () => {
  await withAuthHome(undefined, async () => {
    await Effect.runPromise(Effect.scoped(Layer.build(OpencodeHarnessLive)));
  });
});

test("OpencodeHarnessLive injects every usable provider's key for the layer's lifetime, restores after teardown", async () => {
  await withAuthHome(
    {
      "opencode-go": { type: "api", key: "test-opencode-go-key" },
      openrouter: { type: "api", key: "test-openrouter-key" },
    },
    async () => {
      const previousOpencodeKey = process.env["OPENCODE_API_KEY"];
      const previousOpenrouterKey = process.env["OPENROUTER_API_KEY"];
      delete process.env["OPENCODE_API_KEY"];
      delete process.env["OPENROUTER_API_KEY"];

      const scope = await Effect.runPromise(Scope.make());
      await Effect.runPromise(Layer.build(OpencodeHarnessLive).pipe(Scope.provide(scope)));

      expect(process.env["OPENCODE_API_KEY"]).toBe("test-opencode-go-key");
      expect(process.env["OPENROUTER_API_KEY"]).toBe("test-openrouter-key");

      await Effect.runPromise(Scope.close(scope, Exit.void));

      expect(process.env["OPENCODE_API_KEY"]).toBe(previousOpencodeKey);
      expect(process.env["OPENROUTER_API_KEY"]).toBe(previousOpenrouterKey);
    },
  );
});
