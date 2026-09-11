import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BunHttpServer } from "@effect/platform-bun";
import type { Git } from "@know-the-map/git";
import { guard } from "@know-the-map/harness";
import { AnalysisArtifact } from "@know-the-map/hermeneut";
import { Deferred, Effect, Layer, Option, Schema } from "effect";
import {
  Headers,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { type SourceFile, SourceReadError, ViewerRpc, type ViewerSnapshot } from "./rpc.ts";

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Saved analysis · Know the Map</title><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script type="module" src="/client.js"></script></body></html>`;

/**
 * The browser bundle, built once for the life of the process. The sources
 * cannot change while the server runs, and `Bun.build` does not survive
 * being invoked repeatedly in one process.
 */
let clientBundle: Promise<string> | undefined;
const buildClient = (): Promise<string> => {
  clientBundle ??= Bun.build({
    entrypoints: [fileURLToPath(new URL("./client.tsx", import.meta.url))],
    target: "browser",
    minify: true,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  }).then((built) => {
    const output = built.outputs[0];
    if (!built.success || output === undefined) {
      throw new Error(built.logs.map(String).join("; "));
    }
    return output.text();
  });
  return clientBundle;
};

/** Where the RPC contract is served. */
const RPC_PATH = "/rpc" as const;

/**
 * Largest source file the viewer will read for the citation pane. A cap
 * exists so the pane's virtualized list, not an unbounded read, is the thing
 * that decides how large a file it can show.
 * TODO(config): expose the source-read size cap.
 */
const MAX_SOURCE_BYTES = 1024 * 1024;

/** Hostnames a loopback-only server will answer to. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

export interface ViewerOptions {
  /** Directory inside the repository the analysis was made against. */
  readonly directory: string;
  /** Saved analysis to serve. */
  readonly artifactPath: string;
  /** Loopback port; 0 selects an available one. */
  readonly port: number;
  readonly git: Git["Service"];
}

export interface ViewerHandle {
  /** Address to open, with the port the server actually bound. */
  readonly url: string;
}

export class ViewerStartupError extends Schema.TaggedError<ViewerStartupError>()(
  "ViewerStartupError",
  {
    message: Schema.String.annotate({ description: "Why the viewer could not start." }),
    cause: Schema.optionalKey(Schema.Defect()).annotate({
      description: "The underlying failure, when there was one.",
    }),
  },
) {}

/**
 * Refuses any request that did not come from a page this server itself
 * served.
 *
 * A loopback port is reachable by every page the user visits, so two checks
 * stand between a saved analysis and any website:
 *
 * - `Host` must name a loopback address. This is what defeats DNS
 *   rebinding, the real attack here: a page that rebinds its own hostname
 *   to 127.0.0.1 still sends its own name in `Host`.
 * - `Origin`, when the browser sends one, must be this exact server. It is
 *   compared against `Host` rather than a port captured at startup, so the
 *   two can never disagree.
 *
 * WebSockets are not subject to CORS, so on the RPC path these checks are
 * the whole defence rather than a second layer behind it. Browsers always
 * send `Origin` on a WebSocket handshake, so an absent one there is not a
 * browser and is refused.
 */
const loopbackOnly = <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  R | HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const host = Headers.get(request.headers, "host").pipe(Option.getOrUndefined);
    const hostname = host === undefined ? undefined : host.replace(/:\d+$/, "");
    if (hostname === undefined || !LOOPBACK_HOSTS.has(hostname)) {
      return HttpServerResponse.text("viewer only answers on loopback", { status: 403 });
    }
    const origin = Headers.get(request.headers, "origin").pipe(Option.getOrUndefined);
    const isRpc = new URL(request.url, `http://${host}`).pathname === RPC_PATH;
    if (origin === undefined) {
      return isRpc ? HttpServerResponse.text("origin required", { status: 403 }) : yield* app;
    }
    if (origin !== `http://${host}`) {
      return HttpServerResponse.text("cross-origin request refused", { status: 403 });
    }
    return yield* app;
  });

/**
 * Reads the saved analysis, validates it, and serves it on loopback until
 * the calling scope closes.
 *
 * The file on disk is the trust boundary, so it is decoded once here with
 * the checked `AnalysisArtifact` and held in memory afterwards. Editing the
 * file while the viewer runs changes nothing about what it serves.
 */
export const startViewer = Effect.fn("startViewer")(function* (options: ViewerOptions) {
  yield* guard(
    Number.isInteger(options.port) && options.port >= 0 && options.port <= 65535,
    () => new ViewerStartupError({ message: "port must be an integer between 0 and 65535" }),
  );
  const artifactPath = resolve(options.artifactPath);
  const file = Bun.file(artifactPath);
  const exists = yield* Effect.tryPromise({
    try: () => file.exists(),
    catch: (cause) =>
      new ViewerStartupError({ message: `could not inspect ${options.artifactPath}`, cause }),
  });
  if (!exists) {
    return yield* new ViewerStartupError({
      message: `no analysis found at ${options.artifactPath}; run "ktm analyze" first`,
    });
  }
  const text = yield* Effect.tryPromise({
    try: () => file.text(),
    catch: (cause) =>
      new ViewerStartupError({ message: `could not read ${options.artifactPath}`, cause }),
  });
  const artifact = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AnalysisArtifact))(
    text,
  ).pipe(
    Effect.mapError(
      (cause) =>
        new ViewerStartupError({
          message: `${options.artifactPath} is not a version 1 analysis; rerun "ktm analyze" to regenerate it. ${cause.message}`,
          cause,
        }),
    ),
  );
  const repo = yield* options.git.discover(options.directory).pipe(
    Effect.mapError(
      (cause) =>
        new ViewerStartupError({
          message: `could not read the repository: ${cause.message}`,
          cause,
        }),
    ),
  );
  const snapshot: ViewerSnapshot = { repositoryName: basename(repo.root), artifact };

  // Built once at startup, not scanned per request: the inventory is fixed
  // for the life of the process (see the comment on `startViewer` above),
  // and this is also the security boundary a `readSource` request must
  // clear before git is ever asked for a path.
  const filesByPath = new Map(artifact.files.map((file) => [file.path, file] as const));

  const readSource = Effect.fn("ViewerServer.readSource")(function* ({
    path,
  }: {
    readonly path: string;
  }): Effect.fn.Return<SourceFile, SourceReadError> {
    const file = yield* Effect.succeed(filesByPath.get(path)).pipe(
      Effect.filterOrFail(
        (entry) => entry !== undefined,
        () =>
          new SourceReadError({
            message: `"${path}" is not part of this analysis.`,
            reason: "not_in_analysis",
          }),
      ),
    );
    const read = yield* options.git
      .readSnapshotFile(repo.root, artifact.headCommit, path, file.hash, MAX_SOURCE_BYTES)
      .pipe(
        Effect.catchTag(
          "SnapshotFileError",
          (cause) =>
            new SourceReadError({
              message:
                cause.reason === "binary"
                  ? `"${path}" is a binary file and cannot be shown as source.`
                  : cause.reason === "too_large"
                    ? `"${path}" is too large to display (over ${MAX_SOURCE_BYTES} bytes).`
                    : `"${path}" no longer matches what was analyzed; rerun "ktm analyze" to refresh it.`,
              reason:
                cause.reason === "binary" || cause.reason === "too_large" ? cause.reason : "stale",
            }),
        ),
        Effect.catchTag(
          "GitCommandError",
          (cause) =>
            new SourceReadError({
              message: `"${path}" could not be read from the repository: ${cause.message}`,
              reason: "unreadable",
            }),
        ),
      );
    return { path, content: read.content } satisfies SourceFile;
  });

  const client = yield* Effect.tryPromise({
    try: buildClient,
    catch: (cause) =>
      new ViewerStartupError({ message: "the viewer interface could not be built", cause }),
  });
  const styles = yield* Effect.tryPromise({
    try: () => Bun.file(new URL("./styles.css", import.meta.url)).text(),
    catch: (cause) =>
      new ViewerStartupError({ message: "the viewer stylesheet could not be read", cause }),
  });

  // Everything the page needs is served from this origin, so nothing may be
  // fetched from anywhere else. `connect-src` covers the RPC WebSocket,
  // which is same-origin.
  const csp =
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  const assetHeaders = { "cache-control": "no-store", "content-security-policy": csp };

  const staticLayer = Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      yield* router.add(
        "GET",
        "/",
        HttpServerResponse.text(PAGE, {
          headers: {
            ...assetHeaders,
            "content-type": "text/html; charset=utf-8",
            "referrer-policy": "no-referrer",
          },
        }),
      );
      yield* router.add(
        "GET",
        "/client.js",
        HttpServerResponse.text(client, {
          headers: { ...assetHeaders, "content-type": "text/javascript; charset=utf-8" },
        }),
      );
      yield* router.add(
        "GET",
        "/styles.css",
        HttpServerResponse.text(styles, {
          headers: { ...assetHeaders, "content-type": "text/css; charset=utf-8" },
        }),
      );
    }),
  );

  const rpcLayer = RpcServer.layerHttp({
    group: ViewerRpc,
    path: RPC_PATH,
    protocol: "websocket",
  }).pipe(
    Layer.provide(ViewerRpc.toLayer({ getArtifact: () => Effect.succeed(snapshot), readSource })),
    Layer.merge(staticLayer),
  );

  // `Layer.launch` runs the serving loop; a layer that is only built binds
  // the port and then answers 503, so the server is launched in a forked
  // fiber that lives as long as the caller's scope.
  //
  // Readiness is signalled rather than waited out: the port accepts
  // connections the moment it is bound, which is before the router behind
  // it exists. `ready` is completed by a layer stacked on top of the
  // serving one, so it cannot fire until that has finished building.
  const ready = yield* Deferred.make<string, ViewerStartupError>();
  const announce = Layer.effectDiscard(
    Effect.gen(function* () {
      const address = (yield* HttpServer.HttpServer).address;
      yield* address._tag === "TcpAddress"
        ? Deferred.succeed(ready, `http://127.0.0.1:${address.port}/`)
        : Deferred.fail(
            ready,
            new ViewerStartupError({ message: "viewer server did not bind a TCP port" }),
          );
    }),
  );
  yield* Effect.forkScoped(
    Layer.launch(
      announce.pipe(
        Layer.provideMerge(
          HttpRouter.serve(rpcLayer, { middleware: loopbackOnly }).pipe(
            Layer.provideMerge(
              BunHttpServer.layer({
                port: options.port,
                hostname: "127.0.0.1",
                // Bun's graceful stop waits for open connections, and a browser
                // sitting on the RPC socket is exactly that. Left at the 20s
                // default, Ctrl+C appears to hang.
                // TODO(config): expose the shutdown grace period.
                gracefulShutdownTimeout: "250 millis",
              }),
            ),
            Layer.provide(RpcSerialization.layerJson),
          ),
        ),
      ),
    ),
  );
  const url = yield* Deferred.await(ready);

  return { url } satisfies ViewerHandle;
});
