import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AnalysisArtifact, ArtifactIdentity } from "@know-the-map/hermeneut";
import { ConfigProvider, DateTime, Effect } from "effect";
import { ArtifactNotFoundError, StoreIndexError } from "./errors.ts";
import { repositoryKey } from "./repository-key.ts";
import { ktmHome, Store } from "./store.ts";

test.each([
  "https://github.com/Effect-TS/effect.git",
  "git+https://github.com/effect-ts/effect",
  "git@github.com:Effect-TS/effect.git",
  "ssh://git@github.com/Effect-TS/effect",
])("repositoryKey normalizes %s to github.com/effect-ts/effect", (repository) => {
  expect(repositoryKey(repository)).toBe("github.com/effect-ts/effect");
});

test.each([
  [{ KTM_HOME: "/explicit", XDG_DATA_HOME: "/xdg" }, "/explicit"],
  [{ XDG_DATA_HOME: "/xdg" }, "/xdg/ktm"],
  [{}, join(homedir(), ".local", "share", "ktm")],
])("ktmHome resolves %o to %s", (env, expected) => {
  expect(Effect.runSync(ktmHome.parse(ConfigProvider.fromUnknown(env)))).toBe(expected);
});

const IDENTITY: ArtifactIdentity = {
  repository: "https://github.com/Effect-TS/effect.git",
  commit: "0123456789abcdef0123456789abcdef01234567",
  name: "@effect/platform",
};

const artifact = (generatedAt: string): AnalysisArtifact => ({
  version: 2,
  identity: IDENTITY,
  packageVersion: "4.0.0",
  scope: "packages/platform",
  workspaceDependencies: [{ name: "effect", indexed: false }],
  generatedAt: DateTime.makeUnsafe(generatedAt),
  files: [{ path: "packages/platform/src/index.ts", hash: "aaaa", lineCount: 1 }],
  scopes: [
    {
      id: 1,
      parentScopeId: null,
      originatingComponentId: null,
      inputPaths: ["packages/platform/src/index.ts"],
      result: { kind: "module", summary: "the whole thing", interpretations: [] },
    },
  ],
});

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ktm-store-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const run = <A, E>(use: (store: Store["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store;
      return yield* use(store);
    }).pipe(Effect.provide(Store.layer(home)), Effect.result),
  );

const EXPECTED_PATH = join(
  "store",
  "github.com",
  "effect-ts",
  "effect",
  IDENTITY.commit,
  "%40effect%2Fplatform.json",
);

test("a write creates the artifact file and its index entry; both reads return an equal artifact", async () => {
  const written = artifact("2026-09-20T00:00:00.000Z");
  const outcome = await run((store) =>
    Effect.gen(function* () {
      yield* store.write(written);
      const byIdentity = yield* store.read(IDENTITY);
      const byVersion = yield* store.lookup("@effect/platform", "4.0.0");
      return { byIdentity, byVersion };
    }),
  );

  expect(outcome._tag).toBe("Success");
  if (outcome._tag !== "Success") return;
  expect(existsSync(join(home, EXPECTED_PATH))).toBe(true);
  expect(JSON.parse(readFileSync(join(home, "index.json"), "utf8"))).toEqual({
    "@effect/platform@4.0.0": IDENTITY,
  });
  expect(outcome.success.byIdentity).toEqual(written);
  expect(outcome.success.byVersion).toEqual(written);
});

test("a second write of the same identity leaves one file and one index entry", async () => {
  const outcome = await run((store) =>
    Effect.gen(function* () {
      yield* store.write(artifact("2026-09-20T00:00:00.000Z"));
      yield* store.write(artifact("2026-09-21T00:00:00.000Z"));
      return yield* store.read(IDENTITY);
    }),
  );

  expect(outcome._tag).toBe("Success");
  if (outcome._tag !== "Success") return;
  expect(
    readdirSync(join(home, "store", "github.com", "effect-ts", "effect", IDENTITY.commit)),
  ).toEqual(["%40effect%2Fplatform.json"]);
  expect(Object.keys(JSON.parse(readFileSync(join(home, "index.json"), "utf8")))).toEqual([
    "@effect/platform@4.0.0",
  ]);
  expect(DateTime.formatIso(outcome.success.generatedAt)).toBe("2026-09-21T00:00:00.000Z");
});

test("reading an identity that was never written is not found", async () => {
  const outcome = await run((store) => store.read(IDENTITY));

  expect(outcome._tag).toBe("Failure");
  if (outcome._tag !== "Failure") return;
  expect(outcome.failure).toBeInstanceOf(ArtifactNotFoundError);
});

test("a version the index does not know is not found", async () => {
  const outcome = await run((store) => store.lookup("@effect/platform", "9.9.9"));

  expect(outcome._tag).toBe("Failure");
  if (outcome._tag !== "Failure") return;
  expect(outcome.failure).toBeInstanceOf(ArtifactNotFoundError);
});

test("a truncated index.json fails a lookup with the index error, not an empty index", async () => {
  writeFileSync(join(home, "index.json"), '{"@effect/platform@4.0.0": {"repository": "https://');
  const outcome = await run((store) => store.lookup("@effect/platform", "4.0.0"));

  expect(outcome._tag).toBe("Failure");
  if (outcome._tag !== "Failure") return;
  expect(outcome.failure).toBeInstanceOf(StoreIndexError);
});
