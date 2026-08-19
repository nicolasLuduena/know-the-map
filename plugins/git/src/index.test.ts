import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import gitPlugin from "./index";

const directories: Array<string> = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

const git = (cwd: string, ...args: ReadonlyArray<string>): string => {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
};

describe("Git diff source", () => {
	test("resolves immutable revisions and handles spaces, renames, and deletions", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "wth-git-"));
		directories.push(cwd);
		git(cwd, "init");
		git(cwd, "config", "user.email", "test@example.com");
		git(cwd, "config", "user.name", "Test");
		mkdirSync(join(cwd, "src"));
		writeFileSync(
			join(cwd, "src", "original.ts"),
			`${"export const stable = 1;\n".repeat(20)}`,
		);
		writeFileSync(join(cwd, "deleted.txt"), "delete me\n");
		git(cwd, "add", ".");
		git(cwd, "commit", "-m", "base");
		const base = git(cwd, "rev-parse", "HEAD");

		renameSync(join(cwd, "src", "original.ts"), join(cwd, "src", "renamed.ts"));
		unlinkSync(join(cwd, "deleted.txt"));
		writeFileSync(
			join(cwd, "file with spaces.ts"),
			"export const added = true;\n",
		);
		git(cwd, "add", "-A");
		git(cwd, "commit", "-m", "change");
		const head = git(cwd, "rev-parse", "HEAD");

		const snapshot = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const capabilities = yield* gitPlugin.build;
					const source = capabilities.diffSources?.[0];
					if (source === undefined)
						return yield* Effect.die("git source missing");
					return yield* source.resolve({ base: "HEAD~1", head: "HEAD", cwd });
				}),
			),
		);

		expect(String(snapshot.base)).toBe(base);
		expect(String(snapshot.head)).toBe(head);
		expect(
			snapshot.files.find((file) => file.path === "src/renamed.ts"),
		).toMatchObject({
			status: "renamed",
			previousPath: "src/original.ts",
		});
		expect(
			snapshot.files.find((file) => file.path === "file with spaces.ts")
				?.status,
		).toBe("added");
		expect(
			snapshot.files.find((file) => file.path === "deleted.txt")?.status,
		).toBe("deleted");
		expect(
			snapshot.files.find((file) => file.path === "file with spaces.ts")?.hunks
				.length,
		).toBe(1);
	});
});
