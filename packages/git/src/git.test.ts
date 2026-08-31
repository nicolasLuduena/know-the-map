import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { DirtyTreeError, Git, GitLive, RepoNotFoundError } from "./index.ts";

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
