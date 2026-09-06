import { join } from "node:path";
import { guard } from "@know-the-map/harness";
import { Context, Effect, Layer, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { DirtyTreeError, GitCommandError, RepoNotFoundError, SnapshotFileError } from "./errors.ts";

export interface Repo {
  readonly root: string;
  readonly headCommit: string;
}

export interface InventoryEntry {
  /** Repo-relative path. */
  readonly path: string;
  /** Git blob hash of the file content as found on disk. */
  readonly hash: string;
}

export interface SnapshotFile {
  /** Text content of the blob, decoded as UTF-8. */
  readonly content: string;
  /** Git blob hash of the content read, i.e. the confirmed `expectedHash`. */
  readonly hash: string;
}

/** A program and its arguments, kept together so runs and error text share one value. */
interface Command {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
}

/** Raw result of a finished command: a non-zero exit code is data, not failure. */
interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Raw result of a finished command whose stdout is arbitrary bytes rather
 * than text: `git cat-file --batch` echoes a blob's content verbatim, and
 * `Stream.decodeText()` could throw on (or silently mangle) bytes that
 * aren't valid UTF-8 before we ever get to inspect them.
 */
interface BinaryCommandResult {
  readonly stdout: Uint8Array;
  readonly stderr: string;
  readonly exitCode: number;
}

/** One index record from `git ls-files -s`. */
interface LsFilesRecord {
  /** File mode, e.g. "100644". */
  readonly mode: string;
  /** Blob object id recorded for the path. */
  readonly object: string;
  /** Index stage; nonzero only while a merge conflict is unresolved. */
  readonly stage: number;
  /** Repo-relative path. */
  readonly path: string;
}

/**
 * Read-only view over the repository under analysis. This is also the
 * anti-hallucination oracle: the hermeneut validates every path and line
 * anchor the model claims against what this service reports.
 */
export class Git extends Context.Service<
  Git,
  {
    /**
     * Resolve the repository containing `cwd` and its HEAD commit, without
     * checking whether the worktree is clean. Use this where committed
     * history is read regardless of local edits (e.g. a viewer showing a
     * past commit); `resolve` builds on this and adds the clean-tree guard
     * that analysis relies on.
     */
    discover(cwd: string): Effect.Effect<Repo, RepoNotFoundError | GitCommandError>;
    /**
     * Resolve the repository containing `cwd`. Fails on a dirty worktree:
     * the artifact pins HEAD plus per-file blob hashes, and those only
     * describe the content the model reads while the tree is clean.
     */
    resolve(cwd: string): Effect.Effect<Repo, GitError>;
    /** Every tracked and untracked (non-ignored) file, with content hashes. */
    inventory(root: string): Effect.Effect<ReadonlyArray<InventoryEntry>, GitError>;
    /** 1-based editor-style line count of a repo-relative file. */
    lineCount(root: string, path: string): Effect.Effect<number, GitError>;
    /**
     * Read a file's content at an exact commit, independent of worktree
     * state: a dirty tree, a later commit, or the file's later deletion
     * none of them change what this returns. `expectedHash` guards against
     * reading the wrong content when a caller's view of the repo is stale.
     */
    readSnapshotFile(
      root: string,
      commit: string,
      path: string,
      expectedHash: string,
      maxBytes: number,
    ): Effect.Effect<SnapshotFile, GitCommandError | SnapshotFileError>;
  }
>()("@know-the-map/git/Git") {}

export type GitError = RepoNotFoundError | DirtyTreeError | GitCommandError;

const git = (...args: Array<string>): Command => ({ file: "git", args });

const describe = (command: Command): string => `${command.file} ${command.args.join(" ")}`;

/**
 * Fields of git's `-z` output: NUL-terminated, paths raw and unquoted. We
 * ask for `-z` everywhere paths cross this boundary because it is git's
 * only scripting-safe interface: any valid filename — unicode, spaces,
 * quotes, even newlines — survives verbatim, while the plain-text output
 * would mangle them into quoted escapes an octal decoder could only
 * guess at. The trailing NUL makes a naive split invent an empty field, so
 * drop empties: `resolve()` counts these fields to decide dirty/clean.
 */
const zFields = (out: string): Array<string> => out.split("\0").filter((field) => field.length > 0);

/**
 * Index hashes that id no actual content: a null OID (all zeros) or — what
 * modern git's `git add -N` (intent-to-add) records for a path whose
 * worktree content was never staged — the empty blob. Recompute those from
 * the worktree; a genuinely empty file just rehashes to the same value.
 * `inventory()` does not assume `resolve()` ran first, so it defends this
 * itself.
 */
const isPlaceholderOid = (hash: string): boolean => {
  /** The blob id of empty content. */
  const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391" as const;
  return /^0+$/.test(hash) || hash === EMPTY_BLOB;
};

/**
 * Parse one `git ls-files -s` record. Format: `<mode> <object> <stage>\t
 * <path>`; the tab is the only boundary before the path, which may then
 * hold any byte but NUL.
 */
const parseLsFilesRecord = (record: string): Option.Option<LsFilesRecord> => {
  const tab = record.indexOf("\t");
  const path = tab === -1 ? "" : record.slice(tab + 1);
  const [mode, object, stage] = tab === -1 ? [] : record.slice(0, tab).split(" ");
  const stageNumber = stage === undefined ? Number.NaN : Number.parseInt(stage, 10);
  if (
    mode === undefined ||
    object === undefined ||
    path.length === 0 ||
    Number.isNaN(stageNumber)
  ) {
    return Option.none();
  }
  return Option.some({ mode, object, stage: stageNumber, path });
};

/** Commands that take their input as arguments still get a closed stdin. */
const EMPTY_STDIN = new Uint8Array();

/** Matches a full sha1 (40 hex chars) or sha256 (64 hex chars) git object id. */
const HEX_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const HexObjectId = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(HEX_OBJECT_ID, {
      description: "a full 40-character sha1 or 64-character sha256 hex object id",
    }),
  ),
);

const RepoRelativePath = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((path: string) => {
      if (path.length === 0) {
        return "path must not be empty";
      }
      if (path.includes("\0")) {
        return "path must not contain a NUL byte";
      }
      if (path.startsWith("/")) {
        return "path must be repo-relative, not absolute";
      }
      const badSegment = path
        .split("/")
        .find((segment) => segment === "" || segment === "." || segment === "..");
      return badSegment === undefined ? undefined : `path segment "${badSegment}" is not allowed`;
    }),
  ),
);

/**
 * Validated input to `readSnapshotFile`. Both `path` and `commit` cross into
 * git subprocess arguments and stdin, so their invariants live here rather
 * than in the function body: a schema failure never lets an attacker-shaped
 * value (`../outside`, a flag like `--help`) reach a subprocess at all.
 */
const SnapshotRequest = Schema.Struct({
  commit: HexObjectId.annotate({
    description: "Commit (or other revision) to read the file from, as a full hex object id.",
  }),
  path: RepoRelativePath.annotate({
    description: "Repo-relative path of the file to read.",
  }),
  expectedHash: HexObjectId.annotate({
    description:
      "Blob hash the caller expects at commit:path; a mismatch fails loudly instead of returning unexpected content.",
  }),
  maxBytes: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))).annotate({
    description:
      "Maximum content size in bytes; a larger blob fails as too_large rather than being read into memory.",
  }),
});
type SnapshotRequest = Schema.Schema.Type<typeof SnapshotRequest>;

export const GitLive: Layer.Layer<Git, never, ChildProcessSpawner.ChildProcessSpawner> =
  Layer.effect(
    Git,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      /**
       * Run to completion and return the raw result. A non-zero exit does
       * not fail the effect: exit code is data, used by probes (see
       * `resolve()`) to mean something other than failure. `cwd` is passed
       * as git's `-C` flag, so it only makes sense for git commands.
       */
      const attempt = Effect.fn("Git.attempt")(function* (
        command: Command,
        cwd: string | undefined,
      ): Effect.fn.Return<CommandResult, GitCommandError> {
        const processArgs = cwd === undefined ? [...command.args] : ["-C", cwd, ...command.args];
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(ChildProcess.make(command.file, processArgs)).pipe(
              Effect.mapError(
                (cause) =>
                  new GitCommandError({
                    message: `${describe(command)} failed to spawn`,
                    cause,
                  }),
              ),
            );
            // Drain both pipes concurrently: a process blocked on a full
            // pipe never exits, so the exit code is awaited only after the
            // streams reach EOF.
            const [stdout, stderr] = yield* Effect.zip(
              handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
              handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
              { concurrent: true },
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new GitCommandError({
                    message: `${describe(command)} output could not be read`,
                    cause,
                  }),
              ),
            );
            const exitCode = yield* handle.exitCode.pipe(
              Effect.mapError(
                (cause) =>
                  new GitCommandError({
                    message: `${describe(command)} exit code could not be read`,
                    cause,
                  }),
              ),
            );
            return { stdout, stderr, exitCode: ChildProcessSpawner.ExitCode(exitCode) };
          }),
        );
      });

      /** Run where any non-zero exit is a failure; yields the successful result. */
      const run = Effect.fn("Git.run")(function* (
        command: Command,
        cwd: string | undefined,
      ): Effect.fn.Return<CommandResult, GitCommandError> {
        return yield* attempt(command, cwd).pipe(
          Effect.filterOrFail(
            (result) => result.exitCode === 0,
            (result) =>
              new GitCommandError({
                message: `${describe(command)} exited with code ${result.exitCode}: ${result.stderr.trim()}`,
                cause: new Error(result.stderr.trim()),
              }),
          ),
        );
      });

      /**
       * Like `attempt`, but for commands whose stdout must be read as raw
       * bytes and whose input is fed on stdin rather than argv — used by
       * `readSnapshotFile` to feed `git cat-file --batch` a revision
       * expression without ever placing it on a command line.
       */
      const attemptBinary = Effect.fn("Git.attemptBinary")(function* (
        command: Command,
        cwd: string | undefined,
        input: Uint8Array = EMPTY_STDIN,
      ): Effect.fn.Return<BinaryCommandResult, GitCommandError> {
        const processArgs = cwd === undefined ? [...command.args] : ["-C", cwd, ...command.args];
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner
              .spawn(ChildProcess.make(command.file, processArgs, { stdin: Stream.succeed(input) }))
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new GitCommandError({
                      message: `${describe(command)} failed to spawn`,
                      cause,
                    }),
                ),
              );
            // Collect stdout as raw bytes and only decode the small ASCII
            // header ourselves once we've located it (see readSnapshotFile):
            // the size/binary checks below must see the exact bytes git
            // wrote, not a lossy text decoding of them.
            const [stdoutChunks, stderr] = yield* Effect.zip(
              Stream.runCollect(handle.stdout),
              handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
              { concurrent: true },
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new GitCommandError({
                    message: `${describe(command)} output could not be read`,
                    cause,
                  }),
              ),
            );
            const exitCode = yield* handle.exitCode.pipe(
              Effect.mapError(
                (cause) =>
                  new GitCommandError({
                    message: `${describe(command)} exit code could not be read`,
                    cause,
                  }),
              ),
            );
            return {
              stdout: Buffer.concat(stdoutChunks),
              stderr,
              exitCode: ChildProcessSpawner.ExitCode(exitCode),
            };
          }),
        );
      });

      /** Run where any non-zero exit is a failure; yields the successful result. */
      const runBinary = Effect.fn("Git.runBinary")(function* (
        command: Command,
        cwd: string | undefined,
        input: Uint8Array = EMPTY_STDIN,
      ): Effect.fn.Return<BinaryCommandResult, GitCommandError> {
        return yield* attemptBinary(command, cwd, input).pipe(
          Effect.filterOrFail(
            (result) => result.exitCode === 0,
            (result) =>
              new GitCommandError({
                message: `${describe(command)} exited with code ${result.exitCode}: ${result.stderr.trim()}`,
                cause: new Error(result.stderr.trim()),
              }),
          ),
        );
      });

      const discover = Effect.fn("Git.discover")(function* (cwd: string) {
        // Probes: a non-zero exit means "not a repository"/"no commits yet",
        // not a command failure, so the exit code is read as data.
        const topLevel = yield* attempt(git("rev-parse", "--show-toplevel"), cwd).pipe(
          Effect.filterOrFail(
            (result) => result.exitCode === 0,
            () => new RepoNotFoundError({ message: `"${cwd}" is not inside a git repository` }),
          ),
        );
        const root = topLevel.stdout.trim();

        const head = yield* attempt(git("rev-parse", "HEAD"), root).pipe(
          Effect.filterOrFail(
            (result) => result.exitCode === 0,
            () => new RepoNotFoundError({ message: `repository at "${root}" has no commits yet` }),
          ),
        );
        const headCommit = head.stdout.trim();

        return { root, headCommit } satisfies Repo;
      });

      const resolve = Effect.fn("Git.resolve")(function* (cwd: string) {
        const repo = yield* discover(cwd);

        const status = yield* run(git("status", "--porcelain", "-z"), repo.root);
        const dirty = zFields(status.stdout);
        yield* guard(
          dirty.length === 0,
          () =>
            new DirtyTreeError({
              message: `worktree at "${repo.root}" is dirty; commit or stash before analyzing`,
              entries: dirty,
            }),
        );

        return repo;
      });

      const inventory = Effect.fn("Git.inventory")(function* (root: string) {
        const staged = yield* run(git("ls-files", "-s", "-z"), root);
        const entries: Array<InventoryEntry> = [];
        for (const record of zFields(staged.stdout)) {
          const parsed = parseLsFilesRecord(record);
          if (Option.isNone(parsed)) {
            return yield* new GitCommandError({
              message: `could not parse ls-files record: ${JSON.stringify(record)}`,
              cause: new Error(record),
            });
          }
          const { object, path } = parsed.value;
          entries.push({
            path,
            hash: isPlaceholderOid(object) ? yield* hashObject(root, path) : object,
          });
        }

        const others = yield* run(git("ls-files", "--others", "--exclude-standard", "-z"), root);
        for (const path of zFields(others.stdout)) {
          entries.push({ path, hash: yield* hashObject(root, path) });
        }

        return entries;
      });

      const hashObject = Effect.fn("Git.hashObject")(function* (root: string, path: string) {
        const result = yield* run(git("hash-object", "--", path), root);
        return result.stdout.trim();
      });

      const lineCount = Effect.fn("Git.lineCount")(function* (root: string, path: string) {
        // awk counts the trailing unterminated line, wc -l does not.
        const result = yield* run(
          { file: "awk", args: ["END { print NR }", join(root, path)] },
          undefined,
        );
        const count = Number.parseInt(result.stdout.trim(), 10);
        yield* guard(
          !Number.isNaN(count),
          () =>
            new GitCommandError({
              message: `could not determine line count of "${path}"`,
              cause: new Error(result.stdout),
            }),
        );
        return count;
      });

      const readSnapshotFile = Effect.fn("Git.readSnapshotFile")(function* (
        root: string,
        commit: string,
        path: string,
        expectedHash: string,
        maxBytes: number,
      ): Effect.fn.Return<SnapshotFile, GitCommandError | SnapshotFileError> {
        const request: SnapshotRequest = yield* Schema.decodeUnknownEffect(SnapshotRequest)({
          commit,
          path,
          expectedHash,
          maxBytes,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new GitCommandError({ message: `invalid snapshot request: ${cause.message}`, cause }),
          ),
        );

        // `--batch-check` reports the object id, type and size *without*
        // emitting the content, so an oversized blob is refused having
        // cost a few dozen bytes. Reading content first and checking the
        // size afterwards would spend the memory the limit exists to
        // bound: `--batch` on a 258 MiB blob writes all 258 MiB before
        // anything can reject it.
        const rev = `${request.commit}:${request.path}`;
        const revLine = new TextEncoder().encode(`${rev}\n`);
        const checked = yield* runBinary(git("cat-file", "--batch-check"), root, revLine);

        const headerEnd = checked.stdout.indexOf(0x0a);
        yield* guard(
          headerEnd !== -1,
          () =>
            new GitCommandError({
              message: `cat-file --batch-check produced no output for "${rev}"`,
              cause: new Error(rev),
            }),
        );
        // The header line is always plain ASCII (an object id, a type
        // keyword, a byte count, or the literal "missing"), so decoding
        // just this slice as text is safe regardless of what the object's
        // own content contains.
        const header = new TextDecoder().decode(checked.stdout.subarray(0, headerEnd));

        yield* guard(
          !header.endsWith(" missing"),
          () =>
            new SnapshotFileError({
              message: `"${request.path}" does not exist at ${request.commit}`,
              reason: "missing",
            }),
        );

        // A well-formed header narrows to exactly [oid, type, size]; the
        // refinement (rather than a `guard` on individually-optional
        // destructured fields) is what lets TypeScript treat `oid` and
        // `type` as `string` from here on, not `string | undefined`.
        const [oid, type, size] = yield* Effect.succeed(header.split(" ")).pipe(
          Effect.filterOrFail(
            (parts): parts is [string, string, string] =>
              parts.length === 3 && /^[0-9]+$/.test(parts[2] ?? ""),
            () =>
              new GitCommandError({
                message: `could not parse cat-file --batch-check header: ${JSON.stringify(header)}`,
                cause: new Error(header),
              }),
          ),
          Effect.map(
            ([parsedOid, parsedType, sizeText]) =>
              [parsedOid, parsedType, Number.parseInt(sizeText, 10)] as const,
          ),
        );

        yield* guard(
          oid === request.expectedHash,
          () =>
            new SnapshotFileError({
              message: `"${request.path}" at ${request.commit} is ${oid}, expected ${request.expectedHash}`,
              reason: "hash_mismatch",
            }),
        );

        yield* guard(
          type === "blob",
          () =>
            new SnapshotFileError({
              message: `"${request.path}" at ${request.commit} is a ${type}, not a file`,
              reason: "not_a_file",
            }),
        );

        yield* guard(
          size <= request.maxBytes,
          () =>
            new SnapshotFileError({
              message: `"${request.path}" is ${size} bytes, over the ${request.maxBytes}-byte limit`,
              reason: "too_large",
            }),
        );

        // Only now, with the size known to fit, is the content worth
        // reading. Addressed by object id rather than by revision: `oid`
        // was just proven equal to the schema-validated `expectedHash`, so
        // nothing caller-shaped reaches this command line.
        const blob = yield* runBinary(git("cat-file", "blob", oid), root);
        const content = blob.stdout.subarray(0, size);
        yield* guard(
          !content.includes(0),
          () =>
            new SnapshotFileError({
              message: `"${request.path}" at ${request.commit} contains a NUL byte and is not text`,
              reason: "binary",
            }),
        );

        return { content: new TextDecoder().decode(content), hash: oid } satisfies SnapshotFile;
      });

      return Git.of({ discover, resolve, inventory, lineCount, readSnapshotFile });
    }),
  );
