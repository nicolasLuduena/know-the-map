import { join } from "node:path";
import { guard } from "@know-the-map/harness";
import { Context, Effect, Layer, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { DirtyTreeError, GitCommandError, RepoNotFoundError } from "./errors.ts";

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
     * Resolve the repository containing `cwd`. Fails on a dirty worktree:
     * the artifact pins HEAD plus per-file blob hashes, and those only
     * describe the content the model reads while the tree is clean.
     */
    resolve(cwd: string): Effect.Effect<Repo, GitError>;
    /** Every tracked and untracked (non-ignored) file, with content hashes. */
    inventory(root: string): Effect.Effect<ReadonlyArray<InventoryEntry>, GitError>;
    /** 1-based editor-style line count of a repo-relative file. */
    lineCount(root: string, path: string): Effect.Effect<number, GitError>;
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

      const resolve = Effect.fn("Git.resolve")(function* (cwd: string) {
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

        const status = yield* run(git("status", "--porcelain", "-z"), root);
        const dirty = zFields(status.stdout);
        yield* guard(
          dirty.length === 0,
          () =>
            new DirtyTreeError({
              message: `worktree at "${root}" is dirty; commit or stash before analyzing`,
              entries: dirty,
            }),
        );

        return { root, headCommit } satisfies Repo;
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

      return Git.of({ resolve, inventory, lineCount });
    }),
  );
