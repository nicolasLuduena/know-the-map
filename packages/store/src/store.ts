import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AnalysisArtifact, ArtifactIdentity } from "@know-the-map/hermeneut";
import { Config, Context, Effect, Layer, Predicate, Schema } from "effect";
import { ArtifactNotFoundError, StoreIndexError, StoreIoError } from "./errors.ts";
import { repositoryKey } from "./repository-key.ts";

/**
 * Where everything lives: `KTM_HOME`, then `$XDG_DATA_HOME/ktm`, then
 * `~/.local/share/ktm`. A command that takes a `--home` flag falls back to
 * this (`Flag.withFallbackConfig`), so the flag always wins.
 */
export const ktmHome: Config.Config<string> = Config.string("KTM_HOME").pipe(
  Config.orElse(() =>
    Config.string("XDG_DATA_HOME").pipe(Config.map((dataHome) => join(dataHome, "ktm"))),
  ),
  Config.orElse(() => Config.succeed(join(homedir(), ".local", "share", "ktm"))),
);

/** `name@version` → the identity holding that version's artifact. Several
 * versions may point at one identity when tags share a commit. */
const StoreIndex = Schema.Record(Schema.String, ArtifactIdentity);
type StoreIndex = Schema.Schema.Type<typeof StoreIndex>;

const versionKey = (name: string, version: string): string => `${name}@${version}`;

/**
 * The layout under `home`. Every path segment that comes from outside —
 * a repository key segment, a package name — is escaped so `@scope/name`
 * or an odd host cannot open a directory the layout did not plan for.
 */
export interface StoreLayout {
  readonly home: string;
  readonly index: string;
  /** Bare clone of the repository, fetched once and updated on demand. */
  clone(repository: string): string;
  artifact(identity: ArtifactIdentity): string;
  /** An adapter's saved interactive defaults, one file per adapter. */
  harnessPreferences(adapterId: string): string;
}

export const layout = (home: string): StoreLayout => {
  const keyPath = (repository: string): string =>
    join(...repositoryKey(repository).split("/").map(encodeURIComponent));
  return {
    home,
    index: join(home, "index.json"),
    clone: (repository: string): string => join(home, "repos", `${keyPath(repository)}.git`),
    artifact: (identity: ArtifactIdentity): string =>
      join(
        home,
        "store",
        keyPath(identity.repository),
        identity.commit,
        `${encodeURIComponent(identity.name)}.json`,
      ),
    harnessPreferences: (adapterId: string): string => join(home, "harness", `${adapterId}.json`),
  };
};

const isMissing = (cause: unknown): boolean =>
  Predicate.hasProperty(cause, "code") && cause.code === "ENOENT";

/**
 * Artifacts on disk, one per identity, with `index.json` mapping a
 * `name@version` to the identity so a lookup by version never needs the
 * repository. Files and one index are enough until a lookup is measurably
 * too slow; there is no database.
 */
export class Store extends Context.Service<
  Store,
  {
    readonly layout: StoreLayout;
    /** Save an artifact under its identity, replacing any earlier one. */
    write(artifact: AnalysisArtifact): Effect.Effect<void, StoreIoError | StoreIndexError>;
    read(
      identity: ArtifactIdentity,
    ): Effect.Effect<AnalysisArtifact, StoreIoError | ArtifactNotFoundError>;
    lookup(
      name: string,
      version: string,
    ): Effect.Effect<AnalysisArtifact, StoreIoError | StoreIndexError | ArtifactNotFoundError>;
  }
>()("@know-the-map/store/Store") {
  static readonly layer = (home: string): Layer.Layer<Store> =>
    Layer.sync(Store, () => {
      const paths = layout(home);

      /** Write via a sibling temp file and rename, so a reader never sees a half-written file. */
      const writeAtomically = Effect.fn("Store.writeAtomically")(function* (
        path: string,
        contents: string,
      ): Effect.fn.Return<void, StoreIoError> {
        const temp = `${path}.${process.pid}.tmp`;
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(temp, contents);
            await rename(temp, path);
          },
          catch: (cause) => new StoreIoError({ message: `could not write ${path}`, cause }),
        });
      });

      /** A file's text, or null when it does not exist; any other failure is an error. */
      const readText = Effect.fn("Store.readText")(function* (
        path: string,
      ): Effect.fn.Return<string | null, StoreIoError> {
        return yield* Effect.tryPromise({
          try: () => readFile(path, "utf8"),
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((cause) =>
            isMissing(cause)
              ? Effect.succeed(null)
              : Effect.fail(new StoreIoError({ message: `could not read ${path}`, cause })),
          ),
        );
      });

      const readIndex = Effect.fn("Store.readIndex")(function* (): Effect.fn.Return<
        StoreIndex,
        StoreIoError | StoreIndexError
      > {
        const text = yield* readText(paths.index);
        if (text === null) {
          return {};
        }
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoreIndex))(text).pipe(
          Effect.mapError(
            (cause) =>
              new StoreIndexError({
                message: `${paths.index} is not a valid index; move it aside and re-index. ${cause.message}`,
                cause,
              }),
          ),
        );
      });

      const write = Effect.fn("Store.write")(function* (
        artifact: AnalysisArtifact,
      ): Effect.fn.Return<void, StoreIoError | StoreIndexError> {
        const encoded = yield* Schema.encodeEffect(AnalysisArtifact)(artifact).pipe(Effect.orDie);
        yield* writeAtomically(
          paths.artifact(artifact.identity),
          `${JSON.stringify(encoded, null, 2)}\n`,
        );
        // ponytail: read-modify-write with no lock; two concurrent indexers
        // could drop each other's entry. Add a lock file if that happens.
        const index = yield* readIndex();
        const updated = {
          ...index,
          [`${artifact.identity.name}@${artifact.packageVersion}`]: artifact.identity,
        };
        yield* writeAtomically(paths.index, `${JSON.stringify(updated, null, 2)}\n`);
      });

      const read = Effect.fn("Store.read")(function* (
        identity: ArtifactIdentity,
      ): Effect.fn.Return<AnalysisArtifact, StoreIoError | ArtifactNotFoundError> {
        const path = paths.artifact(identity);
        const text = yield* readText(path);
        if (text === null) {
          return yield* new ArtifactNotFoundError({
            message: `no artifact for ${identity.name} at ${identity.commit} of ${identity.repository}`,
          });
        }
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AnalysisArtifact))(
          text,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new StoreIoError({
                message: `${path} is not a version 2 artifact; re-index to regenerate it. ${cause.message}`,
                cause,
              }),
          ),
        );
      });

      const lookup = Effect.fn("Store.lookup")(function* (
        name: string,
        version: string,
      ): Effect.fn.Return<
        AnalysisArtifact,
        StoreIoError | StoreIndexError | ArtifactNotFoundError
      > {
        const index = yield* readIndex();
        const identity = index[versionKey(name, version)];
        if (identity === undefined) {
          return yield* new ArtifactNotFoundError({
            message: `${name}@${version} is not indexed`,
          });
        }
        return yield* read(identity);
      });

      return Store.of({ layout: paths, write, read, lookup });
    });
}
