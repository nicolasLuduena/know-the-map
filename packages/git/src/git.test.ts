import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import {
  DirtyTreeError,
  Git,
  GitCommandError,
  GitLive,
  RepoNotFoundError,
  SnapshotFileError,
} from "./index.ts";

/** The blob id git assigns to empty content. */
const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

const git = (args: ReadonlyArray<string>, cwd?: string): { code: number; stdout: string } => {
  const result = Bun.spawnSync(cwd === undefined ? ["git", ...args] : ["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  return {
    code: result.exitCode ?? 0,
    stdout: new TextDecoder().decode(result.stdout),
  };
};

const makeRepo = (): { dir: string; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), "ktm-git-"));
  git(["init", "--initial-branch=main"], dir);
  git(
    ["-c", "user.email=test@test", "-c", "user.name=test", "commit", "--allow-empty", "-m", "init"],
    dir,
  );
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const run = <A, E>(
  effect: Effect.Effect<A, E, Git>,
): Promise<{ ok: true; value: A } | { ok: false; error: E } | undefined> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const value = yield* effect;
      return { ok: true as const, value };
    }).pipe(Effect.provide(Layer.provide(GitLive, BunServices.layer))),
  ).then(
    (outcome) => outcome,
    (error) => ({ ok: false as const, error: error as E }),
  );

test("resolve returns root and head commit", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    const outcome = await run(
      Effect.gen(function* () {
        const gitService = yield* Git;
        return yield* gitService.resolve(dir);
      }),
    );
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok) {
      expect(outcome.value.root).toBe(dir);
      expect(outcome.value.headCommit).toBe(git(["rev-parse", "HEAD"], dir).stdout.trim());
    }
  } finally {
    cleanup();
  }
});

test("resolve fails on a directory outside a repository", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ktm-nogit-"));
  try {
    const outcome = await run(
      Effect.gen(function* () {
        const gitService = yield* Git;
        return yield* gitService.resolve(dir);
      }),
    );
    expect(outcome && "error" in outcome ? outcome.error : undefined).toBeInstanceOf(
      RepoNotFoundError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolve fails when the worktree has modified files", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeFileSync(join(dir, "a.ts"), "line\n");
    git(["add", "a.ts"], dir);
    git(["-c", "user.email=test@test", "-c", "user.name=test", "commit", "-m", "a"], dir);
    appendFileSync(join(dir, "a.ts"), "dirt\n");

    const outcome = await run(
      Effect.gen(function* () {
        const gitService = yield* Git;
        return yield* gitService.resolve(dir);
      }),
    );
    expect(outcome && "error" in outcome ? outcome.error : undefined).toBeInstanceOf(
      DirtyTreeError,
    );
  } finally {
    cleanup();
  }
});

test("resolve fails when the worktree has untracked files", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeFileSync(join(dir, "untracked.txt"), "dirt\n");

    const outcome = await run(
      Effect.gen(function* () {
        const gitService = yield* Git;
        return yield* gitService.resolve(dir);
      }),
    );
    expect(outcome && "error" in outcome ? outcome.error : undefined).toBeInstanceOf(
      DirtyTreeError,
    );
  } finally {
    cleanup();
  }
});

test("inventory lists tracked files with content hashes", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeFileSync(join(dir, "a.ts"), "one\ntwo\n");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/b.ts"), "x\n");
    git(["add", "."], dir);
    git(["-c", "user.email=test@test", "-c", "user.name=test", "commit", "-m", "files"], dir);

    const outcome = await run(
      Effect.gen(function* () {
        const gitService = yield* Git;
        return yield* gitService.inventory(dir);
      }),
    );
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok) {
      const byPath = new Map(outcome.value.map((entry) => [entry.path, entry]));
      const a = byPath.get("a.ts");
      const b = byPath.get("src/b.ts");
      expect(a?.hash).toBe(git(["hash-object", "a.ts"], dir).stdout.trim());
      expect(b?.hash).toBe(git(["hash-object", "src/b.ts"], dir).stdout.trim());
    }
  } finally {
    cleanup();
  }
});

test("inventory keeps awkward filenames verbatim, even with git path quoting on", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    // Force git's C-style quoting on: with `-z` it must not touch the paths.
    git(["config", "core.quotePath", "true"], dir);
    writeFileSync(join(dir, "café.ts"), "x\n");
    writeFileSync(join(dir, "two  spaces.ts"), "y\n");
    writeFileSync(join(dir, 'we"ird.ts'), "z\n");
    writeFileSync(join(dir, "line\nbreak.ts"), "w\n"); // -z's raison d'être
    git(["add", "."], dir);
    git(["-c", "user.email=test@test", "-c", "user.name=test", "commit", "-m", "odd names"], dir);
    writeFileSync(join(dir, "naïve.ts"), "v\n"); // untracked: raw through too

    const outcome = await run(
      Effect.gen(function* () {
        const gitService = yield* Git;
        return yield* gitService.inventory(dir);
      }),
    );
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok) {
      const paths = outcome.value.map((entry) => entry.path).sort();
      expect(paths).toEqual([
        "café.ts",
        "line\nbreak.ts",
        "naïve.ts",
        "two  spaces.ts",
        'we"ird.ts',
      ]);
      const byPath = new Map(outcome.value.map((entry) => [entry.path, entry]));
      expect(byPath.get("café.ts")?.hash).toBe(git(["hash-object", "café.ts"], dir).stdout.trim());
      expect(byPath.get("naïve.ts")?.hash).toBe(
        git(["hash-object", "naïve.ts"], dir).stdout.trim(),
      );
    }
  } finally {
    cleanup();
  }
});

test("inventory recomputes placeholder hashes (intent-to-add)", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeFileSync(join(dir, "a.ts"), "one\n");
    git(["add", "."], dir);
    git(["-c", "user.email=test@test", "-c", "user.name=test", "commit", "-m", "a"], dir);
    writeFileSync(join(dir, "new.ts"), "brand new\n");
    git(["add", "-N", "new.ts"], dir); // the index records the empty blob for new.ts
    writeFileSync(join(dir, "empty.ts"), "");
    git(["add", "empty.ts"], dir);

    const outcome = await run(
      Effect.gen(function* () {
        const gitService = yield* Git;
        return yield* gitService.inventory(dir);
      }),
    );
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok) {
      const byPath = new Map(outcome.value.map((entry) => [entry.path, entry]));
      expect(byPath.get("new.ts")?.hash).toBe(git(["hash-object", "new.ts"], dir).stdout.trim());
      expect(byPath.get("new.ts")?.hash).not.toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
      // a genuinely empty file keeps its (legitimately empty) blob id
      expect(byPath.get("empty.ts")?.hash).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    }
  } finally {
    cleanup();
  }
});

test("lineCount counts the trailing unterminated line", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeFileSync(join(dir, "ended.ts"), "one\ntwo\n"); // 2 lines
    writeFileSync(join(dir, "open.ts"), "one\ntwo"); // 2 lines, no trailing newline

    const outcome = await run(
      Effect.gen(function* () {
        const gitService = yield* Git;
        return {
          ended: yield* gitService.lineCount(dir, "ended.ts"),
          open: yield* gitService.lineCount(dir, "open.ts"),
        };
      }),
    );
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok) {
      expect(outcome.value.ended).toBe(2);
      expect(outcome.value.open).toBe(2);
    }
  } finally {
    cleanup();
  }
});

test("discover succeeds on a dirty worktree where resolve fails with DirtyTreeError", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeFileSync(join(dir, "untracked.txt"), "dirt\n");
    const headCommit = git(["rev-parse", "HEAD"], dir).stdout.trim();

    const discovered = await run(
      Effect.gen(function* () {
        const gitService = yield* Git;
        return yield* gitService.discover(dir);
      }),
    );
    expect(discovered?.ok).toBe(true);
    if (discovered?.ok) {
      expect(discovered.value.root).toBe(dir);
      expect(discovered.value.headCommit).toBe(headCommit);
    }

    const resolved = await run(
      Effect.gen(function* () {
        const gitService = yield* Git;
        return yield* gitService.resolve(dir);
      }),
    );
    expect(resolved && "error" in resolved ? resolved.error : undefined).toBeInstanceOf(
      DirtyTreeError,
    );
  } finally {
    cleanup();
  }
});

test("readSnapshotFile reads committed content even while the worktree is dirty", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeFileSync(join(dir, "original.txt"), "committed content\n");
    git(["add", "original.txt"], dir);
    git(["-c", "user.email=test@test", "-c", "user.name=test", "commit", "-m", "add"], dir);
    const commit = git(["rev-parse", "HEAD"], dir).stdout.trim();
    const hash = git(["hash-object", "original.txt"], dir).stdout.trim();

    // Dirty the worktree after the commit: readSnapshotFile must ignore this.
    writeFileSync(join(dir, "original.txt"), "uncommitted edit\n");

    const outcome = await run(
      Effect.gen(function* () {
        const gitService = yield* Git;
        return yield* gitService.readSnapshotFile(dir, commit, "original.txt", hash, 1024);
      }),
    );
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok) {
      expect(outcome.value.content).toBe("committed content\n");
      expect(outcome.value.hash).toBe(hash);
    }
  } finally {
    cleanup();
  }
});

test("readSnapshotFile fails with hash_mismatch when expectedHash is wrong", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "content\n");
    git(["add", "a.txt"], dir);
    git(["-c", "user.email=test@test", "-c", "user.name=test", "commit", "-m", "add"], dir);
    const commit = git(["rev-parse", "HEAD"], dir).stdout.trim();

    const outcome = await run(
      Effect.gen(function* () {
        const gitService = yield* Git;
        return yield* gitService.readSnapshotFile(dir, commit, "a.txt", "0".repeat(40), 1024);
      }),
    );
    const error = outcome && "error" in outcome ? outcome.error : undefined;
    expect(error).toBeInstanceOf(SnapshotFileError);
    expect(error instanceof SnapshotFileError ? error.reason : undefined).toBe("hash_mismatch");
  } finally {
    cleanup();
  }
});

test("readSnapshotFile fails with missing when the path doesn't exist at that commit", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    const commit = git(["rev-parse", "HEAD"], dir).stdout.trim();

    const outcome = await run(
      Effect.gen(function* () {
        const gitService = yield* Git;
        return yield* gitService.readSnapshotFile(
          dir,
          commit,
          "does-not-exist.txt",
          "0".repeat(40),
          1024,
        );
      }),
    );
    const error = outcome && "error" in outcome ? outcome.error : undefined;
    expect(error).toBeInstanceOf(SnapshotFileError);
    expect(error instanceof SnapshotFileError ? error.reason : undefined).toBe("missing");
  } finally {
    cleanup();
  }
});

test("readSnapshotFile fails with not_a_file when the path is a directory", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "f.txt"), "x\n");
    git(["add", "."], dir);
    git(["-c", "user.email=test@test", "-c", "user.name=test", "commit", "-m", "sub"], dir);
    const commit = git(["rev-parse", "HEAD"], dir).stdout.trim();
    const treeHash = git(["rev-parse", `${commit}:sub`], dir).stdout.trim();

    const outcome = await run(
      Effect.gen(function* () {
        const gitService = yield* Git;
        return yield* gitService.readSnapshotFile(dir, commit, "sub", treeHash, 1024);
      }),
    );
    const error = outcome && "error" in outcome ? outcome.error : undefined;
    expect(error).toBeInstanceOf(SnapshotFileError);
    expect(error instanceof SnapshotFileError ? error.reason : undefined).toBe("not_a_file");
  } finally {
    cleanup();
  }
});

test("readSnapshotFile rejects an oversized blob without reading its content", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    // The size here is load-bearing, not arbitrary: `maxBytes` exists to
    // bound how much this can pull into memory, so the blob has to be far
    // larger than the limit for the test to mean anything. Reading content
    // first and checking the size afterwards passes a 100-byte fixture and
    // still allocates every byte of a real one.
    const oversized = 8 * 1024 * 1024;
    writeFileSync(join(dir, "big.txt"), "x".repeat(oversized));
    git(["add", "big.txt"], dir);
    git(["-c", "user.email=test@test", "-c", "user.name=test", "commit", "-m", "big"], dir);
    const commit = git(["rev-parse", "HEAD"], dir).stdout.trim();
    const hash = git(["hash-object", "big.txt"], dir).stdout.trim();

    const outcome = await run(
      Effect.gen(function* () {
        const gitService = yield* Git;
        return yield* gitService.readSnapshotFile(dir, commit, "big.txt", hash, 10);
      }),
    );
    const error = outcome && "error" in outcome ? outcome.error : undefined;
    expect(error).toBeInstanceOf(SnapshotFileError);
    expect(error instanceof SnapshotFileError ? error.reason : undefined).toBe("too_large");
    // The reported size comes from the header, proving the limit was
    // applied against git's own accounting rather than a buffer length.
    expect(error instanceof SnapshotFileError ? error.message : "").toContain(`${oversized}`);
  } finally {
    cleanup();
  }
});

test("readSnapshotFile fails with binary for a file containing NUL bytes", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeFileSync(join(dir, "bin.dat"), Uint8Array.from([0x68, 0x69, 0x00, 0x6a]));
    git(["add", "bin.dat"], dir);
    git(["-c", "user.email=test@test", "-c", "user.name=test", "commit", "-m", "bin"], dir);
    const commit = git(["rev-parse", "HEAD"], dir).stdout.trim();
    const hash = git(["hash-object", "bin.dat"], dir).stdout.trim();

    const outcome = await run(
      Effect.gen(function* () {
        const gitService = yield* Git;
        return yield* gitService.readSnapshotFile(dir, commit, "bin.dat", hash, 1024);
      }),
    );
    const error = outcome && "error" in outcome ? outcome.error : undefined;
    expect(error).toBeInstanceOf(SnapshotFileError);
    expect(error instanceof SnapshotFileError ? error.reason : undefined).toBe("binary");
  } finally {
    cleanup();
  }
});

test("readSnapshotFile reads an empty file back as an empty string", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeFileSync(join(dir, "empty.txt"), "");
    git(["add", "empty.txt"], dir);
    git(["-c", "user.email=test@test", "-c", "user.name=test", "commit", "-m", "empty"], dir);
    const commit = git(["rev-parse", "HEAD"], dir).stdout.trim();

    const outcome = await run(
      Effect.gen(function* () {
        const gitService = yield* Git;
        return yield* gitService.readSnapshotFile(dir, commit, "empty.txt", EMPTY_BLOB, 1024);
      }),
    );
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok) {
      expect(outcome.value.content).toBe("");
      expect(outcome.value.hash).toBe(EMPTY_BLOB);
    }
  } finally {
    cleanup();
  }
});

test("readSnapshotFile reads a path with non-ASCII characters and a space", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeFileSync(join(dir, "café space.txt"), "bonjour\n");
    git(["add", "."], dir);
    git(["-c", "user.email=test@test", "-c", "user.name=test", "commit", "-m", "café"], dir);
    const commit = git(["rev-parse", "HEAD"], dir).stdout.trim();
    const hash = git(["hash-object", "café space.txt"], dir).stdout.trim();

    const outcome = await run(
      Effect.gen(function* () {
        const gitService = yield* Git;
        return yield* gitService.readSnapshotFile(dir, commit, "café space.txt", hash, 1024);
      }),
    );
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok) {
      expect(outcome.value.content).toBe("bonjour\n");
    }
  } finally {
    cleanup();
  }
});

test("readSnapshotFile rejects a path escaping the repo via the schema", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    const commit = git(["rev-parse", "HEAD"], dir).stdout.trim();

    const outcome = await run(
      Effect.gen(function* () {
        const gitService = yield* Git;
        return yield* gitService.readSnapshotFile(dir, commit, "../outside", "0".repeat(40), 1024);
      }),
    );
    const error = outcome && "error" in outcome ? outcome.error : undefined;
    expect(error).toBeInstanceOf(GitCommandError);
    expect(error instanceof GitCommandError ? error.message : "").toContain(
      "invalid snapshot request",
    );
  } finally {
    cleanup();
  }
});

test("readSnapshotFile rejects a non-hex commit via the schema, never reaching git", async () => {
  const { dir, cleanup } = makeRepo();
  try {
    const outcome = await run(
      Effect.gen(function* () {
        const gitService = yield* Git;
        return yield* gitService.readSnapshotFile(dir, "--help", "a.txt", "0".repeat(40), 1024);
      }),
    );
    const error = outcome && "error" in outcome ? outcome.error : undefined;
    expect(error).toBeInstanceOf(GitCommandError);
    expect(error instanceof GitCommandError ? error.message : "").toContain(
      "invalid snapshot request",
    );
  } finally {
    cleanup();
  }
});
