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
	deriveSnapshotId,
	makeRepoPath,
	makeRevision,
} from "@bleentr/domain";
import type { DiffSource } from "@bleentr/plugin-api";
import { DiffError, definePlugin } from "@bleentr/plugin-api";
import { Effect } from "effect";

const capabilityId = "wth.git";

const runGit = (
	args: ReadonlyArray<string>,
	cwd: string,
): Effect.Effect<string, DiffError> =>
	Effect.async<string, DiffError>((resume) => {
		let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
		try {
			proc = Bun.spawn(["git", ...args], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch (error) {
			resume(
				Effect.fail(
					new DiffError({
						capabilityId,
						message: `failed to start git: ${String(error)}`,
					}),
				),
			);
			return Effect.void;
		}
		const stdout = new Response(proc.stdout).text();
		const stderr = new Response(proc.stderr).text();
		void Promise.all([proc.exited, stdout, stderr]).then(
			([code, output, errorOutput]) => {
				if (code === 0) resume(Effect.succeed(output));
				else
					resume(
						Effect.fail(
							new DiffError({
								capabilityId,
								message: errorOutput.trim() || `git exited with code ${code}`,
							}),
						),
					);
			},
			(error) =>
				resume(
					Effect.fail(new DiffError({ capabilityId, message: String(error) })),
				),
		);
		return Effect.sync(() => proc.kill());
	});

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface FileMetadata {
	readonly path: string;
	readonly previousPath?: string;
	readonly status: FileDiff["status"];
}

const parseRawMetadata = (output: string): ReadonlyArray<FileMetadata> => {
	const tokens = output.split("\0");
	const files: Array<FileMetadata> = [];
	let index = 0;
	while (index < tokens.length) {
		const header = tokens[index++];
		if (!header) continue;
		const statusToken = header.trim().split(/\s+/).at(-1) ?? "M";
		const statusCode = statusToken[0] ?? "M";
		const firstPath = tokens[index++] ?? "";
		if (statusCode === "R" || statusCode === "C") {
			const path = tokens[index++] ?? "";
			files.push({
				path,
				previousPath: firstPath,
				status: statusCode === "R" ? "renamed" : "copied",
			});
			continue;
		}
		const status: FileDiff["status"] =
			statusCode === "A"
				? "added"
				: statusCode === "D"
					? "deleted"
					: "modified";
		files.push({ path: firstPath, status });
	}
	return files;
};

const makeRange = (start: number, count: number): LineRange =>
	count === 0 ? { start: 0, end: 0 } : { start, end: start + count - 1 };

const parseHunks = (section: string, path: string): ReadonlyArray<Hunk> => {
	const hunks: Array<Hunk> = [];
	let oldStart = 0;
	let oldCount = 0;
	let newStart = 0;
	let newCount = 0;
	let oldLine = 0;
	let newLine = 0;
	let lines: Array<DiffLine> | undefined;

	const finish = () => {
		if (lines === undefined) return;
		const consumedOld = lines.filter((line) => line.kind !== "addition").length;
		const consumedNew = lines.filter((line) => line.kind !== "deletion").length;
		if (consumedOld !== oldCount || consumedNew !== newCount) {
			throw new Error(`hunk line counts do not match header for ${path}`);
		}
		const oldRange = makeRange(oldStart, oldCount);
		const newRange = makeRange(newStart, newCount);
		hunks.push({
			id: deriveHunkId({ path, oldRange, newRange, lines }),
			oldRange,
			newRange,
			lines,
		});
	};

	for (const line of section.split("\n")) {
		const header = HUNK_HEADER.exec(line);
		if (header !== null) {
			finish();
			oldStart = Number(header[1]);
			oldCount = header[2] === undefined ? 1 : Number(header[2]);
			newStart = Number(header[3]);
			newCount = header[4] === undefined ? 1 : Number(header[4]);
			oldLine = oldStart;
			newLine = newStart;
			lines = [];
			continue;
		}
		if (lines === undefined || line.startsWith("\\")) continue;
		if (line.startsWith("+")) {
			lines.push({
				kind: "addition",
				newLineNumber: newLine,
				content: line.slice(1),
			});
			newLine += 1;
		} else if (line.startsWith("-")) {
			lines.push({
				kind: "deletion",
				oldLineNumber: oldLine,
				content: line.slice(1),
			});
			oldLine += 1;
		} else if (line.startsWith(" ")) {
			lines.push({
				kind: "context",
				oldLineNumber: oldLine,
				newLineNumber: newLine,
				content: line.slice(1),
			});
			oldLine += 1;
			newLine += 1;
		}
	}
	finish();
	return hunks;
};

const parseSnapshot = (
	rawMetadata: string,
	patch: string,
	baseRevision: string,
	headRevision: string,
): DiffSnapshot => {
	const metadata = parseRawMetadata(rawMetadata);
	const sections = patch.split(/^diff --git /m).slice(1);
	const files = metadata.map(
		(file, index): FileDiff => ({
			path: makeRepoPath(file.path),
			...(file.previousPath === undefined
				? {}
				: { previousPath: makeRepoPath(file.previousPath) }),
			status: file.status,
			hunks: parseHunks(sections[index] ?? "", file.path),
		}),
	);
	const base = makeRevision(baseRevision);
	const head = makeRevision(headRevision);
	return decodeDiffSnapshot({
		id: deriveSnapshotId({ base, head, files }),
		base,
		head,
		files,
	});
};

const gitDiffSource: DiffSource = {
	id: capabilityId,
	version: "1",
	resolve: (input) =>
		Effect.gen(function* () {
			const base = (yield* runGit(
				["rev-parse", "--verify", `${input.base}^{commit}`],
				input.cwd,
			)).trim();
			const head = (yield* runGit(
				["rev-parse", "--verify", `${input.head}^{commit}`],
				input.cwd,
			)).trim();
			const pathArgs = input.path === undefined ? [] : ["--", input.path];
			const common = [
				"--find-renames",
				"--find-copies",
				base,
				head,
				...pathArgs,
			];
			const [raw, patch] = yield* Effect.all(
				[
					runGit(["diff", "--raw", "-z", ...common], input.cwd),
					runGit(
						[
							"diff",
							"--patch",
							"--no-color",
							"--no-ext-diff",
							"--unified=3",
							...common,
						],
						input.cwd,
					),
				],
				{ concurrency: 2 },
			);
			return yield* Effect.try({
				try: () => parseSnapshot(raw, patch, base, head),
				catch: (error) =>
					new DiffError({
						capabilityId,
						message: `failed to parse git diff: ${String(error)}`,
					}),
			});
		}),
};

export default definePlugin({
	id: capabilityId,
	version: "1",
	apiVersion: 1,
	build: Effect.succeed({ diffSources: [gitDiffSource] }),
});
