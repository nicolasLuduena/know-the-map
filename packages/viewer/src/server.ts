import { basename, resolve } from "node:path";
import { BunHttpServer } from "@effect/platform-bun";
import type { Git } from "@know-the-map/git";
import { guard } from "@know-the-map/harness";
import { AnalysisArtifact } from "@know-the-map/hermeneut";
import { Deferred, Effect, Layer, Schema } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { ViewerRpc, type ViewerSnapshot } from "./rpc.ts";

/** Where the RPC contract is served. */
const RPC_PATH = "/rpc" as const;

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
    const host = request.headers["host"];
    const hostname = host === undefined ? undefined : host.replace(/:\d+$/, "");
    if (hostname === undefined || !LOOPBACK_HOSTS.has(hostname)) {
      return HttpServerResponse.text("viewer only answers on loopback", { status: 403 });
    }
    const origin = request.headers["origin"];
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

  const rpcLayer = RpcServer.layerHttp({
    group: ViewerRpc,
    path: RPC_PATH,
    protocol: "websocket",
  }).pipe(Layer.provide(ViewerRpc.toLayer({ getArtifact: () => Effect.succeed(snapshot) })));

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
