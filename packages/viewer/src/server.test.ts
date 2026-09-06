import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Git, GitLive } from "@know-the-map/git";
import { AnalysisArtifact } from "@know-the-map/hermeneut";
import { DateTime, Effect, Layer, Schema } from "effect";
import { SourceResponse, ViewerResponse } from "./protocol.ts";
import { startViewer, type ViewerHandle } from "./server.ts";

let directory: string;
let viewer: ViewerHandle;
let artifact: AnalysisArtifact;
let artifactPath: string;
const layer = GitLive.pipe(Layer.provide(BunServices.layer));
const git = (...args: string[]): string => {
  const result = Bun.spawnSync(["git", "-C", directory, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};
const launch = (path: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* Git;
      return yield* startViewer({ directory, artifactPath: path, port: 0, git: service });
    }).pipe(Effect.provide(layer)),
  );
const endpoint = (path: string, query: Record<string, string> = {}): string => {
  const url = new URL(viewer.url);
  url.pathname = path;
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.href;
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "ktm-viewer-"));
  git("init", "--initial-branch=main");
  await writeFile(join(directory, "source.txt"), "one\ntwo\nthree\n");
  await writeFile(join(directory, "empty.txt"), "");
  await writeFile(join(directory, "binary.dat"), new Uint8Array([0, 1, 2]));
  await writeFile(join(directory, "large.txt"), "x".repeat(1024 * 1024 + 1));
  await writeFile(join(directory, "café space.txt"), "special path\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture");
  const paths = ["source.txt", "empty.txt", "binary.dat", "large.txt", "café space.txt"];
  artifact = {
    version: 1,
    headCommit: git("rev-parse", "HEAD"),
    generatedAt: DateTime.makeUnsafe("2026-09-05T12:00:00Z"),
    components: [],
    relationships: [],
    interpretations: [],
    files: paths.map((path) => ({
      path,
      hash: git("rev-parse", `HEAD:${path}`),
      lineCount: path === "source.txt" ? 3 : path === "empty.txt" ? 0 : 1,
    })),
    scopes: [
      {
        id: 1,
        parentScopeId: null,
        originatingComponentId: null,
        inputPaths: paths,
        result: { kind: "module", summary: "Source fixture", interpretations: [] },
      },
    ],
  };
  artifactPath = join(directory, "analysis.json");
  await writeFile(artifactPath, JSON.stringify(Schema.encodeSync(AnalysisArtifact)(artifact)));
  await writeFile(join(directory, "source.txt"), "changed working tree\n");
  viewer = await launch(artifactPath);
});
afterAll(async () => {
  viewer?.stop();
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
});

test("serves validated saved data and pinned source despite dirty worktree", async () => {
  const response = await fetch(endpoint("/api/artifact"));
  const payload = Schema.decodeUnknownSync(ViewerResponse)(await response.json());
  expect(payload.artifact.headCommit).toBe(artifact.headCommit);
  const source = await fetch(
    endpoint("/api/source", { path: "source.txt", lineStart: "2", lineEnd: "3" }),
  );
  expect(source.status).toBe(200);
  expect(Schema.decodeUnknownSync(SourceResponse)(await source.json()).content).toBe(
    "one\ntwo\nthree\n",
  );
  const empty = await fetch(endpoint("/api/source", { path: "empty.txt" }));
  expect(Schema.decodeUnknownSync(SourceResponse)(await empty.json()).content).toBe("");
  expect((await fetch(endpoint("/api/source", { path: "café space.txt" }))).status).toBe(200);
});

test("authentication, host/origin checks and read-only methods protect local source", async () => {
  const anonymous = new URL(endpoint("/api/source", { path: "source.txt" }));
  anonymous.searchParams.delete("token");
  expect((await fetch(anonymous)).status).toBe(401);
  expect(
    (await fetch(endpoint("/api/artifact"), { headers: { Origin: "https://example.com" } })).status,
  ).toBe(403);
  expect(
    (await fetch(endpoint("/api/artifact"), { headers: { Host: "evil.example" } })).status,
  ).toBe(403);
  expect((await fetch(endpoint("/api/artifact"), { method: "POST" })).status).toBe(405);
  expect((await fetch(endpoint("/api/source", { path: "../secret" }))).status).toBe(404);
});

test("source errors stay local to the pane, including malformed ranges and oversized/binary files", async () => {
  for (const path of ["large.txt", "binary.dat"])
    expect((await fetch(endpoint("/api/source", { path }))).status).toBe(422);
  expect(
    (await fetch(endpoint("/api/source", { path: "source.txt", lineStart: "1x", lineEnd: "2" })))
      .status,
  ).toBe(400);
  expect(
    (await fetch(endpoint("/api/source", { path: "source.txt", lineStart: "1" }))).status,
  ).toBe(400);
  expect(
    (await fetch(endpoint("/api/source", { path: "source.txt", lineStart: "2", lineEnd: "1" })))
      .status,
  ).toBe(422);
  expect(
    (await fetch(endpoint("/api/source", { path: "source.txt", lineStart: "1", lineEnd: "10" })))
      .status,
  ).toBe(422);
  expect((await fetch(endpoint("/api/artifact"))).status).toBe(200);
});

test("saved payload stays fixed when artifact on disk changes", async () => {
  await writeFile(artifactPath, "invalid replacement");
  const response = await fetch(endpoint("/api/artifact"));
  expect(Schema.decodeUnknownSync(ViewerResponse)(await response.json()).artifact.headCommit).toBe(
    artifact.headCommit,
  );
});

test("missing and legacy artifacts fail with actionable startup errors", async () => {
  await expect(launch(join(directory, "missing.json"))).rejects.toThrow("run ktm analyze first");
  const legacy = join(directory, "legacy.json");
  await writeFile(legacy, JSON.stringify({ headCommit: artifact.headCommit }));
  await expect(launch(legacy)).rejects.toThrow("rerun ktm analyze");
});

test("Git source reader rejects mismatched hashes, missing objects and invalid paths", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* Git;
      const first = artifact.files[0];
      if (first === undefined) throw new Error("fixture file missing");
      const cases = [
        { commit: artifact.headCommit, path: first.path, hash: "0".repeat(40) },
        { commit: "0".repeat(40), path: first.path, hash: first.hash },
        { commit: artifact.headCommit, path: "../outside", hash: first.hash },
        { commit: "--help", path: first.path, hash: first.hash },
      ];
      for (const item of cases) {
        const result = yield* Effect.result(
          service.readSnapshotFile(directory, item.commit, item.path, item.hash, 1024),
        );
        expect(result._tag).toBe("Failure");
      }
    }).pipe(Effect.provide(layer)),
  );
});
