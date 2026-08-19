import { describe, expect, test } from "bun:test";
import type { DiffSnapshot } from "@bleentr/domain";
import {
	deriveHunkId,
	deriveSnapshotId,
	makeRepoPath,
	makeRevision,
} from "@bleentr/domain";
import type { CacheEntry, CacheStore } from "@bleentr/plugin-api";
import { definePlugin, makePluginRegistryLayer } from "@bleentr/plugin-api";
import { makeAnalysisSchedulerLayer } from "@bleentr/scheduler";
import { Chunk, Effect, Layer, Option, Stream } from "effect";
import {
	makeEngineConfigLayer,
	makeReviewEngineLayer,
	ReviewEngineService,
} from "./index";

const snapshot = (): DiffSnapshot => {
	const base = makeRevision("a".repeat(40));
	const head = makeRevision("b".repeat(40));
	const lines = [
		{
			kind: "addition" as const,
			newLineNumber: 1,
			content: "const answer = 42;",
		},
	];
	const oldRange = { start: 0, end: 0 };
	const newRange = { start: 1, end: 1 };
	const hunk = {
		id: deriveHunkId({ path: "answer.ts", oldRange, newRange, lines }),
		oldRange,
		newRange,
		lines,
	};
	const files = [
		{
			path: makeRepoPath("answer.ts"),
			status: "added" as const,
			hunks: [hunk],
		},
	];
	return { id: deriveSnapshotId({ base, head, files }), base, head, files };
};

const runWith = <A, E>(
	plugin: ReturnType<typeof definePlugin>,
	effect: Effect.Effect<A, E, ReviewEngineService>,
) => {
	const dependencies = Layer.mergeAll(
		makePluginRegistryLayer([plugin]),
		makeAnalysisSchedulerLayer({ defaultConcurrency: 1 }),
		makeEngineConfigLayer({
			diffSourceId: "source",
			analyzerId: "analyzer",
			cacheStoreId: "cache",
			contextProviderIds: ["context"],
			contextPolicy: {
				maxReferencesPerSymbol: 5,
				includeTests: true,
				includeIncomingCalls: true,
				includeOutgoingCalls: false,
				traversalDepth: 1,
			},
			maxContextFragments: 2,
			maxContextCharacters: 100,
		}),
	);
	const layer = makeReviewEngineLayer.pipe(Layer.provide(dependencies));
	return Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped));
};

describe("ReviewEngine", () => {
	test("uses configured providers, streams a validated result, and caches completion", async () => {
		let analyzerRuns = 0;
		let contextRuns = 0;
		let reviewContextCount = 0;
		const entries = new Map<string, CacheEntry>();
		const cache: CacheStore = {
			id: "cache",
			version: "1",
			get: (key) => Effect.succeed(Option.fromNullable(entries.get(key))),
			set: (key, entry) =>
				Effect.sync(() => {
					entries.set(key, entry);
				}),
			delete: (key) =>
				Effect.sync(() => {
					entries.delete(key);
				}),
		};
		const plugin = definePlugin({
			id: "test",
			version: "1",
			apiVersion: 1,
			build: Effect.succeed({
				contextProviders: [
					{
						id: "context",
						version: "1",
						collect: () => {
							contextRuns += 1;
							return Stream.succeed({
								id: "fragment",
								source: "search",
								uri: "answer.ts",
								excerpt: "const answer = 42",
								reason: "changed symbol",
							});
						},
					},
				],
				analyzers: [
					{
						id: "analyzer",
						version: "1",
						analyze: () => {
							analyzerRuns += 1;
							return Stream.make(
								{ _tag: "Text" as const, text: "working" },
								{
									_tag: "Complete" as const,
									explanation: {
										summary: "Adds an answer",
										behaviorChanges: ["exports answer"],
										risks: [],
										confidence: 1,
									},
								},
							);
						},
						review: ({ context }) => {
							reviewContextCount = context.length;
							return Stream.make(
								{ _tag: "Text" as const, text: "reviewing" },
								{ _tag: "Complete" as const },
							);
						},
					},
				],
				cacheStores: [cache],
			}),
		});
		const inputSnapshot = snapshot();
		const hunkId = inputSnapshot.files[0]?.hunks[0]?.id;
		if (hunkId === undefined) throw new Error("fixture hunk missing");

		const results = await runWith(
			plugin,
			Effect.gen(function* () {
				const engine = yield* ReviewEngineService;
				const first = yield* engine
					.explainHunk({ snapshot: inputSnapshot, hunkId })
					.pipe(Stream.runCollect);
				const second = yield* engine
					.explainHunk({ snapshot: inputSnapshot, hunkId })
					.pipe(Stream.runCollect);
				const review = yield* engine
					.reviewDiff({ snapshot: inputSnapshot })
					.pipe(Stream.runCollect);
				return [
					Chunk.toReadonlyArray(first),
					Chunk.toReadonlyArray(second),
					Chunk.toReadonlyArray(review),
				] as const;
			}),
		);
		expect(results[0].map((event) => event._tag)).toEqual(["Text", "Complete"]);
		expect(results[1].map((event) => event._tag)).toEqual(["Complete"]);
		expect(results[2].map((event) => event._tag)).toEqual(["Text", "Complete"]);
		expect(analyzerRuns).toBe(1);
		expect(contextRuns).toBe(3);
		expect(reviewContextCount).toBe(1);
	});
});
