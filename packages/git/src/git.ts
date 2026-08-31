import { join } from "node:path";
import { Context, Effect, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { DirtyTreeError, GitCommandError, RepoNotFoundError } from "./errors.ts";

export interface Repo {
  readonly root: string;
  readonly headCommit: string;
}

export interface InventoryEntry {
  /** Repo-relative path. */
  readonly path: string;
  /** Git object id of the file content (HEAD == worktree on a clean tree). */
  readonly hash: string;
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
     * the analysis pins HEAD, and a clean tree is what makes worktree
     * content and HEAD content identical.
     */
    resolve(cwd: string): Effect.Effect<Repo, GitError>;
    /** Every tracked and untracked (non-ignored) file, with content hashes. */
    inventory(root: string): Effect.Effect<ReadonlyArray<InventoryEntry>, GitError>;
    /** 1-based editor-style line count of a repo-relative file. */
    lineCount(root: string, path: string): Effect.Effect<number, GitError>;
  }
>()("@know-the-map/git/Git") {}

export type GitError = RepoNotFoundError | DirtyTreeError | GitCommandError;

const unquote = (path: string): string =>
  path.startsWith('"') && path.endsWith('"') ? (JSON.parse(path) as string) : path;

const lines = (out: string): Array<string> => out.split("\n").filter((line) => line.length > 0);

const stripHash = (hash: string): string => (/^0+$/.test(hash) ? "" : hash);

export const GitLive: Layer.Layer<Git, never, ChildProcessSpawner.ChildProcessSpawner> =
  Layer.effect(
    Git,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      /**
       * Run a command, draining stdout and stderr concurrently so a chatty
       * process cannot deadlock on a full pipe. Non-zero exits do not fail
       * the effect: callers decide what an exit code means for them.
       */
      const run = Effect.fn("Git.run")(function* (
        command: string,
        args: ReadonlyArray<string>,
        cwd: string | undefined,
      ) {
        const processArgs = cwd === undefined ? [...args] : ["-C", cwd, ...args];
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(ChildProcess.make(command, processArgs)).pipe(
              Effect.mapError(
                (cause) =>
                  new GitCommandError({
                    message: `${command} ${args.join(" ")} failed to spawn`,
                    cause,
                  }),
              ),
            );
            const [stdout, stderr, exitCode] = yield* Effect.all(
              [
                handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
                handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
                handle.exitCode,
              ],
              { concurrency: 2 },
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new GitCommandError({
                    message: `${command} ${args.join(" ")} output could not be read`,
                    cause,
                  }),
              ),
            );
            return { stdout, stderr, exitCode: ChildProcessSpawner.ExitCode(exitCode) };
          }),
        );
      });

      const expectSuccess = Effect.fn("Git.expectSuccess")(function* (
        command: string,
        args: ReadonlyArray<string>,
        result: { stdout: string; stderr: string; exitCode: number },
      ) {
        if (result.exitCode !== 0) {
          return yield* new GitCommandError({
            message: `${command} ${args.join(" ")} exited with code ${result.exitCode}: ${result.stderr.trim()}`,
            cause: new Error(result.stderr.trim()),
          });
        }
        return result.stdout;
      });

      const resolve = Effect.fn("Git.resolve")(function* (cwd: string) {
        const topLevel = yield* run("git", ["rev-parse", "--show-toplevel"], cwd);
        if (topLevel.exitCode !== 0) {
          return yield* new RepoNotFoundError({
            message: `"${cwd}" is not inside a git repository`,
          });
        }
        const root = topLevel.stdout.trim();

        const head = yield* run("git", ["rev-parse", "HEAD"], root);
        if (head.exitCode !== 0) {
          return yield* new RepoNotFoundError({
            message: `repository at "${root}" has no commits yet`,
          });
        }
        const headCommit = head.stdout.trim();

        const status = yield* run("git", ["status", "--porcelain"], root);
        if (status.exitCode !== 0) {
          return yield* new GitCommandError({
            message: "git status --porcelain failed",
            cause: new Error(status.stderr.trim()),
          });
        }
        const entries = lines(status.stdout);
        if (entries.length > 0) {
          return yield* new DirtyTreeError({
            message: `worktree at "${root}" is dirty; commit or stash before analyzing`,
            entries,
          });
        }

        return { root, headCommit } satisfies Repo;
      });

      const inventory = Effect.fn("Git.inventory")(function* (root: string) {
        const staged = yield* run("git", ["ls-files", "-s"], root);
        const stdout = yield* expectSuccess("git", ["ls-files", "-s"], staged);
        const entries: Array<InventoryEntry> = [];
        for (const line of lines(stdout)) {
          const tokens = line.split(/\s+/);
          const hash = tokens[1];
          const path = unquote(tokens.slice(3).join(" "));
          if (hash === undefined || path.length === 0) {
            return yield* new GitCommandError({
              message: `could not parse ls-files line: ${JSON.stringify(line)}`,
              cause: new Error(line),
            });
          }
          const cleanHash = stripHash(hash);
          entries.push({
            path,
            hash: cleanHash.length > 0 ? cleanHash : yield* hashObject(root, path),
          });
        }

        const others = yield* run("git", ["ls-files", "--others", "--exclude-standard"], root);
        const othersStdout = yield* expectSuccess(
          "git",
          ["ls-files", "--others", "--exclude-standard"],
          others,
        );
        for (const path of lines(othersStdout)) {
          entries.push({ path, hash: yield* hashObject(root, path) });
        }

        return entries;
      });

      const hashObject = Effect.fn("Git.hashObject")(function* (root: string, path: string) {
        const result = yield* run("git", ["hash-object", "--", path], root);
        return yield* expectSuccess("git", ["hash-object", "--", path], result).pipe(
          Effect.map((out) => out.trim()),
        );
      });

      const lineCount = Effect.fn("Git.lineCount")(function* (root: string, path: string) {
        // awk counts the trailing unterminated line, wc -l does not.
        const result = yield* run("awk", ["END { print NR }", join(root, path)], undefined);
        const stdout = yield* expectSuccess("awk", ["END { print NR }", path], result);
        const count = Number.parseInt(stdout.trim(), 10);
        if (Number.isNaN(count)) {
          return yield* new GitCommandError({
            message: `could not determine line count of "${path}"`,
            cause: new Error(stdout),
          });
        }
        return count;
      });

      return Git.of({ resolve, inventory, lineCount });
    }),
  );
