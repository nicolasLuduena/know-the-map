import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Git } from "@know-the-map/git";
import { guard } from "@know-the-map/harness";
import { AnalysisArtifact } from "@know-the-map/hermeneut";
import { Effect, Option, Schema } from "effect";
import { SourceQuery, SourceResponse, ViewerErrorResponse, ViewerResponse } from "./protocol.ts";

const MAX_SOURCE_BYTES = 1024 * 1024; // TODO(config): expose the source display limit.

export interface ViewerOptions {
  readonly directory: string;
  readonly artifactPath: string;
  readonly port: number;
  readonly git: Git["Service"];
}

export interface ViewerHandle {
  readonly url: string;
  readonly stop: () => void;
}

export class ViewerStartupError extends Schema.TaggedError<ViewerStartupError>()(
  "ViewerStartupError",
  {
    message: Schema.String.annotate({ description: "Why the viewer could not start." }),
    cause: Schema.optionalKey(Schema.Defect()).annotate({
      description: "Underlying startup failure.",
    }),
  },
) {}

const errorResponse = (message: string, status: number): Response =>
  Response.json(Schema.encodeSync(ViewerErrorResponse)({ message }), {
    status,
    headers: { "Cache-Control": "no-store" },
  });

export const startViewer = Effect.fn("startViewer")(function* (options: ViewerOptions) {
  yield* guard(
    Number.isInteger(options.port) && options.port >= 0 && options.port <= 65535,
    () => new ViewerStartupError({ message: "port must be an integer between 0 and 65535" }),
  );
  const artifactFile = Bun.file(resolve(options.artifactPath));
  const exists = yield* Effect.tryPromise({
    try: () => artifactFile.exists(),
    catch: (cause) =>
      new ViewerStartupError({ message: `could not inspect ${options.artifactPath}`, cause }),
  });
  if (!exists)
    return yield* new ViewerStartupError({
      message: `analysis artifact not found at ${options.artifactPath}; run ktm analyze first`,
    });
  const text = yield* Effect.tryPromise({
    try: () => artifactFile.text(),
    catch: (cause) =>
      new ViewerStartupError({ message: `could not read ${options.artifactPath}`, cause }),
  });
  const artifact = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AnalysisArtifact))(
    text,
  ).pipe(
    Effect.mapError(
      (cause) =>
        new ViewerStartupError({
          message: `analysis artifact is invalid or uses an unsupported format; rerun ktm analyze. ${cause.message}`,
          cause,
        }),
    ),
  );
  const repo = yield* options.git.discover(options.directory);
  const payload = yield* Schema.encodeEffect(ViewerResponse)({
    repositoryName: basename(repo.root),
    artifact,
  });
  const inventory = new Map(artifact.files.map((file) => [file.path, file]));
  const build = yield* Effect.tryPromise({
    try: () =>
      Bun.build({
        entrypoints: [fileURLToPath(new URL("./client.tsx", import.meta.url))],
        target: "browser",
        minify: true,
        define: { "process.env.NODE_ENV": JSON.stringify("production") },
      }),
    catch: (cause) =>
      new ViewerStartupError({ message: "viewer client could not be built", cause }),
  });
  const output = build.outputs[0];
  if (!build.success || output === undefined)
    return yield* new ViewerStartupError({
      message: `viewer client could not be built: ${build.logs.map(String).join("; ")}`,
    });
  const client = yield* Effect.tryPromise({
    try: () => output.text(),
    catch: (cause) => new ViewerStartupError({ message: "could not read viewer bundle", cause }),
  });
  const styles = yield* Effect.tryPromise({
    try: () => Bun.file(new URL("./styles.css", import.meta.url)).text(),
    catch: (cause) => new ViewerStartupError({ message: "could not read viewer styles", cause }),
  });
  const token = crypto.randomUUID();
  const server = yield* Effect.try({
    try: () =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: options.port,
        async fetch(request, server) {
          const url = new URL(request.url);
          const host = `127.0.0.1:${server.port}`;
          if (request.method !== "GET") return errorResponse("method not allowed", 405);
          if (url.host !== host || request.headers.get("Host") !== host)
            return errorResponse("invalid host", 403);
          const origin = request.headers.get("Origin");
          if (origin !== null && origin !== `http://${host}`)
            return errorResponse("invalid origin", 403);
          if (url.searchParams.get("token") !== token) return errorResponse("unauthorized", 401);
          if (url.pathname === "/")
            return new Response(
              `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Saved analysis · Know the Map</title><link rel="stylesheet" href="/styles.css?token=${token}"></head><body><div id="root"></div><script type="module" src="/client.js?token=${token}"></script></body></html>`,
              {
                headers: {
                  "Content-Type": "text/html; charset=utf-8",
                  "Referrer-Policy": "no-referrer",
                  "Cache-Control": "no-store",
                  "Content-Security-Policy":
                    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
                },
              },
            );
          if (url.pathname === "/client.js")
            return new Response(client, {
              headers: {
                "Content-Type": "text/javascript; charset=utf-8",
                "Cache-Control": "no-store",
              },
            });
          if (url.pathname === "/styles.css")
            return new Response(styles, {
              headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store" },
            });
          if (url.pathname === "/api/artifact")
            return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
          if (url.pathname !== "/api/source") return errorResponse("not found", 404);
          const parsed = Schema.decodeUnknownOption(SourceQuery)(
            Object.fromEntries(url.searchParams),
          );
          if (Option.isNone(parsed))
            return errorResponse("source path and optional positive line range are required", 400);
          const query = parsed.value;
          const status = inventory.get(query.path);
          if (status === undefined)
            return errorResponse(`"${query.path}" is not part of this analysis`, 404);
          if (
            query.lineStart !== undefined &&
            query.lineEnd !== undefined &&
            (!Number.isSafeInteger(Number(query.lineStart)) ||
              !Number.isSafeInteger(Number(query.lineEnd)) ||
              Number(query.lineEnd) < Number(query.lineStart) ||
              Number(query.lineEnd) > status.lineCount)
          )
            return errorResponse(`cited lines are outside "${query.path}"`, 422);
          return await Effect.runPromise(
            options.git
              .readSnapshotFile(
                repo.root,
                artifact.headCommit,
                query.path,
                status.hash,
                MAX_SOURCE_BYTES,
              )
              .pipe(
                Effect.map((file) => {
                  const count =
                    file.content === ""
                      ? 0
                      : file.content.split("\n").length - (file.content.endsWith("\n") ? 1 : 0);
                  if (query.lineEnd !== undefined && Number(query.lineEnd) > count)
                    return errorResponse(`cited lines are outside "${query.path}"`, 422);
                  return Response.json(
                    Schema.encodeSync(SourceResponse)({
                      path: query.path,
                      commit: artifact.headCommit,
                      content: file.content,
                    }),
                    { headers: { "Cache-Control": "no-store" } },
                  );
                }),
                Effect.catchTag("SnapshotFileError", (error) =>
                  Effect.succeed(errorResponse(error.message, 422)),
                ),
                Effect.catchTag("GitCommandError", (error) =>
                  Effect.succeed(errorResponse(error.message, 422)),
                ),
              ),
          );
        },
      }),
    catch: (cause) => new ViewerStartupError({ message: "viewer server could not start", cause }),
  });
  return {
    url: `http://127.0.0.1:${server.port}/?token=${token}`,
    stop: () => {
      server.stop(true);
    },
  } satisfies ViewerHandle;
});
