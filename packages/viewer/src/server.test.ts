import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Git, GitLive } from "@know-the-map/git";
import { AnalysisArtifact } from "@know-the-map/hermeneut";
import { Effect, Layer, Schema } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { Socket } from "effect/unstable/socket";
import { ViewerRpc } from "./rpc.ts";
import { startViewer, ViewerStartupError } from "./server.ts";

let directory: string;
let artifactPath: string;

const gitRun = (args: Array<string>): void => {
  const result = Bun.spawnSync(["git", "-C", directory, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
};

const gitLayer = GitLive.pipe(Layer.provide(BunServices.layer));

/**
 * Runs `use` against a freshly started viewer, then closes its scope. Each
 * test gets its own server on its own ephemeral port, so none of them can
 * leak state into another.
 */
const withViewer = <A, E>(
  path: string,
  use: (url: string) => Effect.Effect<A, E, never>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const git = yield* Git;
      const handle = yield* startViewer({ directory, artifactPath: path, port: 0, git });
      return yield* use(handle.url);
    }).pipe(Effect.scoped, Effect.provide(gitLayer), Effect.orDie),
  );

/**
 * An RPC client whose WebSocket carries an `Origin`, which is what a
 * browser does automatically and what the server requires on `/rpc`. Bun's
 * WebSocket takes headers; the DOM type does not describe that argument.
 */
const clientLayer = (url: string, origin: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(`${url.replace(/^http/, "ws")}rpc`)),
    Layer.provide(
      Layer.succeed(Socket.WebSocketConstructor)(
        (wsUrl) =>
          new WebSocket(wsUrl, { headers: { Origin: origin } } as never) as globalThis.WebSocket,
      ),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );

const validArtifact = (headCommit: string) => ({
  version: 1,
  headCommit,
  generatedAt: "2026-09-06T00:00:00.000Z",
  files: [{ path: "a.ts", hash: "0".repeat(40), lineCount: 1 }],
  scopes: [
    {
      id: 1,
      parentScopeId: null,
      originatingComponentId: null,
      inputPaths: ["a.ts"],
      result: { kind: "module", summary: "the whole thing", interpretations: [] },
    },
  ],
});

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "ktm-viewer-"));
  gitRun(["init", "--initial-branch=main"]);
  writeFileSync(join(directory, "a.ts"), "one\n");
  gitRun(["add", "."]);
  gitRun(["-c", "user.name=Test", "-c", "user.email=test@test", "commit", "-m", "fixture"]);
  const head = Bun.spawnSync(["git", "-C", directory, "rev-parse", "HEAD"])
    .stdout.toString()
    .trim();
  artifactPath = join(directory, "analysis.json");
  writeFileSync(artifactPath, JSON.stringify(validArtifact(head)));
  // Dirty the worktree: viewing committed analysis must not require a clean
  // tree the way analyzing does.
  writeFileSync(join(directory, "a.ts"), "edited after the commit\n");
});

afterAll(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
});

test("serves the saved analysis over RPC, with a dirty worktree", async () => {
  const snapshot = await withViewer(artifactPath, (url) =>
    Effect.gen(function* () {
      const client = yield* RpcClient.make(ViewerRpc);
      return yield* client.getArtifact();
    }).pipe(Effect.scoped, Effect.provide(clientLayer(url, url.replace(/\/$/, "")))),
  );

  expect(snapshot.repositoryName).toBe(basename(directory));
  expect(snapshot.artifact.scopes).toHaveLength(1);
});

test("refuses a foreign Host, a foreign Origin, and an Origin-less RPC upgrade", async () => {
  const statuses = await withViewer(artifactPath, (url) =>
    Effect.promise(async () => {
      const host = new URL(url).host;
      const foreignHost = await fetch(`${url}rpc`, { headers: { Host: "evil.example" } });
      const foreignOrigin = await fetch(`${url}rpc`, {
        headers: { Host: host, Origin: "https://evil.example" },
      });
      const noOrigin = await fetch(`${url}rpc`, { headers: { Host: host } });
      return {
        foreignHost: foreignHost.status,
        foreignOrigin: foreignOrigin.status,
        noOrigin: noOrigin.status,
      };
    }),
  );

  expect(statuses.foreignHost).toBe(403);
  expect(statuses.foreignOrigin).toBe(403);
  // A browser always sends Origin on a WebSocket handshake, and WebSockets
  // are not subject to CORS — so an absent Origin here is not a browser.
  expect(statuses.noOrigin).toBe(403);
});

test("serves the interface, its bundle and its stylesheet, all fenced", async () => {
  const served = await withViewer(artifactPath, (url) =>
    Effect.promise(async () => {
      const host = new URL(url).host;
      const page = await fetch(url, { headers: { Host: host } });
      const script = await fetch(`${url}client.js`, { headers: { Host: host } });
      const styles = await fetch(`${url}styles.css`, { headers: { Host: host } });
      const foreign = await fetch(url, { headers: { Host: "evil.example" } });
      return {
        pageStatus: page.status,
        pageBody: await page.text(),
        csp: page.headers.get("content-security-policy") ?? "",
        scriptType: script.headers.get("content-type") ?? "",
        scriptBody: await script.text(),
        stylesType: styles.headers.get("content-type") ?? "",
        stylesBody: await styles.text(),
        foreignStatus: foreign.status,
      };
    }),
  );

  expect(served.pageStatus).toBe(200);
  expect(served.pageBody).toContain('id="root"');
  expect(served.pageBody).toContain('src="/client.js"');
  // Nothing on the page may load from anywhere but this origin.
  expect(served.csp).toContain("default-src 'none'");
  expect(served.csp).toContain("connect-src 'self'");
  expect(served.scriptType).toContain("text/javascript");
  expect(served.scriptBody.length).toBeGreaterThan(1000);
  expect(served.stylesType).toContain("text/css");
  expect(served.stylesBody).toContain("--signal");
  // The fence covers the interface, not just the RPC path.
  expect(served.foreignStatus).toBe(403);
});

test("a missing artifact fails to start with an actionable message", async () => {
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const git = yield* Git;
      return yield* startViewer({
        directory,
        artifactPath: join(directory, "absent.json"),
        port: 0,
        git,
      });
    }).pipe(Effect.scoped, Effect.provide(gitLayer), Effect.result),
  );

  expect(outcome._tag).toBe("Failure");
  if (outcome._tag !== "Failure") return;
  expect(outcome.failure).toBeInstanceOf(ViewerStartupError);
  expect(outcome.failure.message).toContain("ktm analyze");
});

test("an artifact from the old format fails to start, naming the version", async () => {
  const legacy = join(directory, "legacy.json");
  // The pre-scopes shape: flat arrays, no version, no scopes.
  writeFileSync(
    legacy,
    JSON.stringify({
      headCommit: "0".repeat(40),
      generatedAt: "2026-09-06T00:00:00.000Z",
      components: [],
      relationships: [],
      interpretations: [],
      files: [],
    }),
  );

  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const git = yield* Git;
      return yield* startViewer({ directory, artifactPath: legacy, port: 0, git });
    }).pipe(Effect.scoped, Effect.provide(gitLayer), Effect.result),
  );

  expect(outcome._tag).toBe("Failure");
  if (outcome._tag !== "Failure") return;
  expect(outcome.failure.message).toContain("version 1");
});

test("the served payload is fixed at startup, not re-read per request", async () => {
  const scopes = await withViewer(artifactPath, (url) =>
    Effect.gen(function* () {
      // Corrupt the file the viewer started from: what it serves must not
      // change, because it was read once and validated once.
      yield* Effect.sync(() => writeFileSync(artifactPath, "no longer valid json"));
      const rpc = yield* RpcClient.make(ViewerRpc);
      const snapshot = yield* rpc.getArtifact();
      return snapshot.artifact.scopes.length;
    }).pipe(Effect.provide(clientLayer(url, url.replace(/\/$/, ""))), Effect.scoped),
  );
  writeFileSync(artifactPath, JSON.stringify(validArtifact("0".repeat(40))));

  expect(scopes).toBe(1);
});

test("the artifact schema still rejects a hand-edited file", () => {
  expect(() =>
    Schema.decodeUnknownSync(AnalysisArtifact)({ ...validArtifact("0".repeat(40)), scopes: [] }),
  ).toThrow("exactly one root scope");
});
