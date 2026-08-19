import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
	DiffSnapshotSchema,
	deriveHunkId,
	deriveSnapshotId,
	HunkExplanationSchema,
	LineRangeSchema,
	makeRepoPath,
	makeRevision,
} from "./index";

describe("domain schemas", () => {
	test("optional values remain ordinary serializable fields", () => {
		const explanation = Schema.decodeUnknownSync(HunkExplanationSchema)({
			summary: "summary",
			behaviorChanges: [],
			risks: [],
			confidence: 0.5,
		});
		expect(explanation.intent).toBeUndefined();
		expect(JSON.parse(JSON.stringify(explanation))).toEqual(explanation);
	});

	test("line ranges reject invalid sentinels and reversed ranges", () => {
		expect(() =>
			Schema.decodeUnknownSync(LineRangeSchema)({ start: 0, end: 1 }),
		).toThrow();
		expect(() =>
			Schema.decodeUnknownSync(LineRangeSchema)({ start: 3, end: 2 }),
		).toThrow();
		expect(
			Schema.decodeUnknownSync(LineRangeSchema)({ start: 0, end: 0 }),
		).toEqual({ start: 0, end: 0 });
	});

	test("content identities are deterministic and snapshot-sensitive", () => {
		const lines = [
			{ kind: "addition" as const, newLineNumber: 1, content: "hello" },
		];
		const range = { start: 1, end: 1 };
		const hunkId = deriveHunkId({
			path: "a.ts",
			oldRange: { start: 0, end: 0 },
			newRange: range,
			lines,
		});
		expect(
			deriveHunkId({
				path: "a.ts",
				oldRange: { start: 0, end: 0 },
				newRange: range,
				lines,
			}),
		).toBe(hunkId);
		const base = makeRevision("a".repeat(40));
		const head = makeRevision("b".repeat(40));
		const files = [
			{
				path: makeRepoPath("a.ts"),
				status: "added" as const,
				hunks: [
					{
						id: hunkId,
						oldRange: { start: 0, end: 0 },
						newRange: range,
						lines,
					},
				],
			},
		];
		const first = deriveSnapshotId({ base, head, files });
		const second = deriveSnapshotId({
			base,
			head,
			files: [
				{
					path: makeRepoPath("b.ts"),
					status: "added",
					hunks: files[0]?.hunks ?? [],
				},
			],
		});
		expect(first).not.toBe(second);
		expect(() =>
			Schema.decodeUnknownSync(DiffSnapshotSchema)({
				id: first,
				base,
				head,
				files,
			}),
		).not.toThrow();
	});
});
