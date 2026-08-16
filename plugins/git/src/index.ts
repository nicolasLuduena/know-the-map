import type {
	DiffLine,
	DiffSnapshot,
	FileDiff,
	Hunk,
	LineRange,
} from "@bleentr/domain";
import {
	decodeDiffSnapshot,
	deriveHunkId,
	makeRepoPath,
	makeRevision,
	makeSnapshotId,
} from "@bleentr/domain";
import type { ContextProvider, DiffSource } from "@bleentr/plugin-api";
import { DiffError, definePlugin } from "@bleentr/plugin-api";
import { Effect, Stream } from "effect";

// -- Git execution ------------------------------------------------------------

const runGit = (
	args: ReadonlyArray<string>,
	cwd: string,
): Effect.Effect<string, DiffError> =>
	Effect.tryPromise({
		try: async () => {
			const proc = Bun.spawn(["git", ...args], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			const code = await proc.exited;
			const stdout = await new Response(proc.stdout).text();
			if (code !== 0) {
				const stderr = await new Response(proc.stderr).text();
				throw new Error(stderr.trim() || `git exited with code ${code}`);
			}
			return stdout;
		},
		catch: (error) =>
			new DiffError({
				message: `git diff failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			}),
	});

// -- Unified diff parsing -------------------------------------------------------

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?(?: @@)?/;

interface HunkAccumulator {
	readonly oldStart: number;
	readonly oldCount: number;
	readonly newStart: number;
	readonly newCount: number;
	readonly lines: Array<DiffLine>;
}

const makeRange = (start: number, count: number): LineRange => {
	if (count === 0) return { start: 0, end: 0 };
	return { start, end: start + count - 1 };
};

const makeHunk = (accumulator: HunkAccumulator, path: string): Hunk => {
	const oldRange = makeRange(accumulator.oldStart, accumulator.oldCount);
	const newRange = makeRange(accumulator.newStart, accumulator.newCount);
	const lines: ReadonlyArray<DiffLine> = accumulator.lines;
	return {
		id: deriveHunkId({ path, oldRange, newRange, lines }),
		oldRange,
		newRange,
		lines,
	};
};

const parseDiff = (
	output: string,
	base: string,
	head: string,
): DiffSnapshot => {
	const files: Array<FileDiff> = [];
	for (const raw of output.split("diff --git ")) {
		if (raw.trim() === "") continue;
		const lines = raw.replace(/\n$/, "").split("\n");
		const header = lines[0] ?? "";
		const bPath = header.indexOf(" b/");
		const path = bPath >= 0 ? header.slice(bPath + " b/".length) : header;

		let status: FileDiff["status"] = "modified";
		for (const line of lines) {
			if (line.startsWith("new file mode")) {
				status = "added";
				break;
			}
			if (line.startsWith("deleted file mode")) {
				status = "deleted";
				break;
			}
		}

		const hunks: Array<Hunk> = [];
		let current: HunkAccumulator | null = null;
		let oldLine = 0;
		let newLine = 0;
		for (const line of lines.slice(1)) {
			if (line.startsWith("\\")) continue;
			const match = HUNK_HEADER.exec(line);
			if (match !== null) {
				const oldStart = Number(match[1]);
				const oldCount = match[2] !== undefined ? Number(match[2]) : 1;
				const newStart = Number(match[3]);
				const newCount = match[4] !== undefined ? Number(match[4]) : 1;
				if (current !== null) hunks.push(makeHunk(current, path));
				current = { oldStart, oldCount, newStart, newCount, lines: [] };
				oldLine = oldStart;
				newLine = newStart;
				continue;
			}
			if (current === null) continue;
			if (line.startsWith("+")) {
				current.lines.push({
					kind: "addition",
					newLineNumber: newLine,
					content: line.slice(1),
				});
				newLine += 1;
			} else if (line.startsWith("-")) {
				current.lines.push({
					kind: "deletion",
					oldLineNumber: oldLine,
					content: line.slice(1),
				});
				oldLine += 1;
			} else if (line.startsWith(" ")) {
				current.lines.push({
					kind: "context",
					oldLineNumber: oldLine,
					newLineNumber: newLine,
					content: line.slice(1),
				});
				oldLine += 1;
				newLine += 1;
			}
		}
		if (current !== null) hunks.push(makeHunk(current, path));
		if (hunks.length === 0) continue;
		files.push({ path: makeRepoPath(path), status, hunks });
	}
	return {
		id: makeSnapshotId(base, head),
		base: makeRevision(base),
		head: makeRevision(head),
		files,
	};
};

// -- DiffSource capability -------------------------------------------------------

const gitDiffSource: DiffSource = {
	id: "wth.git",
	resolve: (input) =>
		Effect.gen(function* () {
			const cwd = input.cwd ?? process.cwd();
			const args = [
				"diff",
				"--no-ext-diff",
				"--unified=3",
				input.base,
				input.head,
			];
			if (input.path) args.push("--", input.path);
			const output = yield* runGit(args, cwd);
			return yield* Effect.try({
				try: () => {
					const snapshot = parseDiff(output, input.base, input.head);
					return decodeDiffSnapshot(snapshot);
				},
				catch: (error) =>
					new DiffError({
						message: `failed to parse git diff: ${
							error instanceof Error ? error.message : String(error)
						}`,
					}),
			});
		}),
};

// -- ContextProvider capability ----------------------------------------------------

const emptyContextProvider: ContextProvider = {
	id: "wth.git",
	collect: () => Stream.empty,
};

export default definePlugin({
	id: "wth.git",
	apiVersion: 1,
	capabilities: {
		diffSources: [gitDiffSource],
		contextProviders: [emptyContextProvider],
	},
});
