import type {
	DiffSnapshot,
	Hunk,
	HunkExplanation,
	HunkId,
} from "@bleentr/domain";
import {
	decodeDiffSnapshot,
	decodeHunkExplanation,
	HunkExplanationSchema,
	makeRepoPath,
} from "@bleentr/domain";
import type {
	AgentEvent,
	AgentRunner,
	Analyzer,
	CacheStore,
	DiffSource,
	PromptPolicy,
} from "@bleentr/plugin-api";
import {
	AgentRunners,
	Analyzers,
	CacheError,
	CacheStores,
	DiffError,
	DiffSources,
	PromptPolicies,
} from "@bleentr/plugin-api";
import { AnalysisSchedulerService } from "@bleentr/scheduler";
import { DateTime, Effect, Option, Schema, Stream } from "effect";

// -- Error protocol -------------------------------------------------------------

export class EngineError extends Schema.TaggedError<EngineError>()(
	"EngineError",
	{ message: Schema.String },
) {}

// -- Inputs ---------------------------------------------------------------------

export interface ReviewEngineInputResolveDiff {
	readonly base: string;
	readonly head: string;
	readonly path?: string;
	readonly cwd?: string;
}

export interface ReviewEngineInputExplain {
	readonly snapshot: DiffSnapshot;
	readonly hunkId: HunkId;
	readonly analyzer?: string;
}

export interface ReviewEngineInputAsk {
	readonly snapshot: DiffSnapshot;
	readonly hunkId: HunkId;
	readonly question: string;
}

export interface ReviewEngineInputReviewDiff {
	readonly snapshot: DiffSnapshot;
}

// -- ReviewEngine ----------------------------------------------------------------

export interface ReviewEngine {
	readonly resolveDiff: (
		input: ReviewEngineInputResolveDiff,
	) => Effect.Effect<DiffSnapshot, EngineError>;
	readonly explainHunk: (
		input: ReviewEngineInputExplain,
	) => Effect.Effect<HunkExplanation, EngineError>;
	readonly askAboutHunk: (
		input: ReviewEngineInputAsk,
	) => Stream.Stream<AgentEvent, EngineError>;
	readonly reviewDiff: (
		input: ReviewEngineInputReviewDiff,
	) => Stream.Stream<never, EngineError>;
}

export class ReviewEngineService extends Effect.Service<ReviewEngineService>()(
	"wth/ReviewEngineService",
	{
		effect: Effect.gen(function* () {
			const sources: ReadonlyArray<DiffSource> = yield* DiffSources;
			const analyzers: ReadonlyArray<Analyzer> = yield* Analyzers;
			const runners: ReadonlyArray<AgentRunner> = yield* AgentRunners;
			const caches: ReadonlyArray<CacheStore> = yield* CacheStores;
			const policies: ReadonlyArray<PromptPolicy> = yield* PromptPolicies;
			const scheduler = yield* AnalysisSchedulerService;

			const findHunk = (
				snapshot: DiffSnapshot,
				hunkId: HunkId,
			): Effect.Effect<Hunk, EngineError> =>
				Effect.gen(function* () {
					const hunk = snapshot.files
						.flatMap((file) => file.hunks)
						.find((candidate) => candidate.id === hunkId);
					if (hunk === undefined) {
						return yield* Effect.fail(
							new EngineError({ message: `hunk not found: ${hunkId}` }),
						);
					}
					return hunk;
				});

			const resolveDiff = (
				input: ReviewEngineInputResolveDiff,
			): Effect.Effect<DiffSnapshot, EngineError> =>
				Effect.gen(function* () {
					const source = Option.fromNullable(sources[0]);
					if (Option.isNone(source)) {
						return yield* Effect.fail(
							new EngineError({ message: "no diff source configured" }),
						);
					}
					const snapshot = yield* source.value
						.resolve({
							base: input.base,
							head: input.head,
							...(input.path === undefined
								? {}
								: { path: makeRepoPath(input.path) }),
							...(input.cwd === undefined ? {} : { cwd: input.cwd }),
						})
						.pipe(
							Effect.catchTag(DiffError._tag, (error) =>
								Effect.fail(new EngineError({ message: error.message })),
							),
						);
					return yield* Effect.try({
						try: () => decodeDiffSnapshot(snapshot),
						catch: (error) =>
							new EngineError({
								message: `invalid diff snapshot: ${String(error)}`,
							}),
					});
				});

			const explainHunk = (
				input: ReviewEngineInputExplain,
			): Effect.Effect<HunkExplanation, EngineError> =>
				Effect.gen(function* () {
					const hunk = yield* findHunk(input.snapshot, input.hunkId);
					const analyzer = Option.fromNullable(
						input.analyzer === undefined
							? analyzers[0]
							: analyzers.find((candidate) => candidate.id === input.analyzer),
					);
					if (Option.isNone(analyzer)) {
						return yield* Effect.fail(
							new EngineError({
								message:
									input.analyzer === undefined
										? "no analyzer configured"
										: `analyzer not found: ${input.analyzer}`,
							}),
						);
					}
					const cache = Option.fromNullable(caches[0]);
					const cacheKey = `explain:${input.hunkId}:${analyzer.value.id}`;
					if (Option.isSome(cache)) {
						const entry = yield* cache.value
							.get(cacheKey)
							.pipe(
								Effect.catchTag(CacheError._tag, () =>
									Effect.succeed(Option.none()),
								),
							);
						if (Option.isSome(entry)) {
							// Cache hit: decode best-effort; a corrupt entry falls
							// through to a fresh computation.
							const cached = Option.liftThrowable(() =>
								decodeHunkExplanation(JSON.parse(entry.value.value)),
							)();
							if (Option.isSome(cached)) return cached.value;
						}
					}
					const analyzed = yield* scheduler
						.submit({
							key: `analyze:${hunk.id}:${analyzer.value.id}`,
							backend: analyzer.value.id,
							priority: "visible",
							task: analyzer.value.analyze({ hunk, context: [] }),
						})
						.pipe(
							Effect.catchAll((error) =>
								Effect.fail(
									new EngineError({
										message:
											error instanceof Error ? error.message : String(error),
									}),
								),
							),
						);
					// Validate the analysis: round-trip the decoded value through
					// encodeSync (throws on an invalid `HunkExplanation`) and back
					// through decodeHunkExplanation to a canonical form.
					const validated = yield* Effect.try({
						try: () =>
							decodeHunkExplanation(
								Schema.encodeSync(HunkExplanationSchema)(analyzed),
							),
						catch: (error) =>
							new EngineError({
								message: `invalid analysis: ${String(error)}`,
							}),
					});
					if (Option.isSome(cache)) {
						yield* cache.value
							.set(cacheKey, {
								value: JSON.stringify(
									Schema.encodeSync(HunkExplanationSchema)(validated),
								),
								storedAt: DateTime.unsafeNow(),
								expiresAt: Option.none(),
							})
							.pipe(Effect.catchTag(CacheError._tag, () => Effect.void));
					}
					return validated;
				});

			const askAboutHunk = (
				input: ReviewEngineInputAsk,
			): Stream.Stream<AgentEvent, EngineError> =>
				Stream.fromEffect(
					Effect.gen(function* () {
						const hunk = yield* findHunk(input.snapshot, input.hunkId);
						const runner = Option.fromNullable(runners[0]);
						if (Option.isNone(runner)) {
							return yield* Effect.fail(
								new EngineError({
									message: "no agent runner configured",
								}),
							);
						}
						const policy = Option.fromNullable(policies[0]);
						const prompt = Option.match(policy, {
							onNone: () =>
								`Question about hunk ${hunk.id}:\n${hunk.lines
									.map(
										(line) =>
											`${
												line.kind === "addition"
													? "+"
													: line.kind === "deletion"
														? "-"
														: " "
											}${line.content}`,
									)
									.join("\n")}`,
							onSome: (policy) => policy.buildPrompt({ hunk, context: [] }),
						});
						return {
							runner: runner.value,
							request: {
								prompt: `${prompt}\n\nUser question: ${input.question}`,
							},
						};
					}),
				).pipe(
					Stream.flatMap(({ runner, request }) =>
						runner
							.run(request)
							.pipe(
								Stream.mapError(
									(error) => new EngineError({ message: error.message }),
								),
							),
					),
				);

			const reviewDiff = (
				_input: ReviewEngineInputReviewDiff,
			): Stream.Stream<never, EngineError> =>
				Stream.fail(
					new EngineError({ message: "reviewDiff: not implemented in MVP" }),
				);

			return { resolveDiff, explainHunk, askAboutHunk, reviewDiff };
		}),
		dependencies: [
			DiffSources.Default,
			Analyzers.Default,
			AgentRunners.Default,
			CacheStores.Default,
			PromptPolicies.Default,
			AnalysisSchedulerService.Default,
		],
	},
) {}
