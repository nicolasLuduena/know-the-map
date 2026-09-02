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

/** C escapes git may emit inside a quoted path, beyond `\"` and `\\`. */
const C_ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11,
};

/**
 * Plumbing output quotes paths containing control bytes or — under git's
 * default `core.quotePath=true` — non-ASCII ones: the path's raw UTF-8 bytes
 * come back as octal `\ooo` escapes inside double quotes
 * (e.g. `"caf\303\251.ts"`). JSON.parse cannot be used: octal escapes are
 * invalid JSON and throw. Decode the byte escapes and reinterpret them as
 * UTF-8. Without this, a real file lands in the inventory under a ghost
 * path (or crashes) and the anti-hallucination oracle rejects it.
 */
const unquote = (path: string): string => {
  if (!(path.startsWith('"') && path.endsWith('"'))) {
    return path;
  }
  const body = path.slice(1, -1);
  const at = (index: number): string => body[index] ?? "";
  const isDigit = (c: string): boolean => c >= "0" && c <= "7";
  const bytes: Array<number> = [];
  for (let i = 0; i < body.length; i++) {
    const ch = at(i);
    if (ch !== "\\") {
      bytes.push(ch.charCodeAt(0));
      continue;
    }
    const esc = at(++i);
    if (isDigit(esc)) {
      let value = esc.charCodeAt(0) - 48;
      for (let digits = 1; digits < 3 && isDigit(at(i + 1)); digits++) {
        i++;
        value = value * 8 + (at(i).charCodeAt(0) - 48);
      }
      bytes.push(value);
    } else {
      bytes.push(C_ESCAPES[esc] ?? esc.charCodeAt(0));
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
};

/**
 * Git commands terminate output with a newline, so a naive split invents a
 * trailing empty entry — load-bearing for `resolve()`, which decides
 * dirty/clean by counting the entries of `status --porcelain`.
 */
const trimEmptyLines = (out: string): Array<string> =>
  out.split("\n").filter((line) => line.length > 0);

/** The blob id of empty content. */
const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

/**
 * Index hashes that id no actual content: a null OID (all zeros) or — what
 * modern git's `git add -N` (intent-to-add) records for a path whose
 * worktree content was never staged — the empty blob. Recompute those from
 * the worktree; a genuinely empty file just rehashes to the same value.
 * `inventory()` does not assume `resolve()` ran first, so it defends this
 * itself.
 */
const isPlaceholderOid = (hash: string): boolean => /^0+$/.test(hash) || hash === EMPTY_BLOB;

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
        const entries = trimEmptyLines(status.stdout);
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
        for (const line of trimEmptyLines(stdout)) {
          // Format: `<mode> <object> <stage>\t<path>`; only the path may
          // contain whitespace, so split on the tab, never on the spaces.
          const tab = line.indexOf("\t");
          const meta = tab === -1 ? [] : line.slice(0, tab).split(" ");
          const hash = meta[1];
          const path = tab === -1 ? "" : unquote(line.slice(tab + 1));
          if (hash === undefined || path.length === 0) {
            return yield* new GitCommandError({
              message: `could not parse ls-files line: ${JSON.stringify(line)}`,
              cause: new Error(line),
            });
          }
          entries.push({
            path,
            hash: isPlaceholderOid(hash) ? yield* hashObject(root, path) : hash,
          });
        }

        const others = yield* run("git", ["ls-files", "--others", "--exclude-standard"], root);
        const othersStdout = yield* expectSuccess(
          "git",
          ["ls-files", "--others", "--exclude-standard"],
          others,
        );
        // `--others` quotes paths the same way, so it needs the same unquote.
        for (const path of trimEmptyLines(othersStdout).map(unquote)) {
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
