import { createHash } from "node:crypto";
import type {
	DiffSnapshot,
	Hunk,
	HunkExplanation,
	HunkId,
} from "@bleentr/domain";
import {
	decodeDiffSnapshot,
	decodeHunkExplanation,
	makeRepoPath,
} from "@bleentr/domain";
import type {
	AgentEvent,
	AgentMessage,
	AnalyzeInput,
	Analyzer,
	ContextFragment,
	ContextPolicy,
	ExplanationEvent,
	ReviewAnalysisEvent,
} from "@bleentr/plugin-api";
import {
	type AnalysisError,
	type CacheError,
	type ContextError,
	ContextPolicySchema,
	type DiffError,
	ExplanationEventSchema,
	PluginRegistry,
	ReviewAnalysisEventSchema,
} from "@bleentr/plugin-api";
import { AnalysisSchedulerService } from "@bleentr/scheduler";
import type { Fiber, Queue as QueueType, Stream as StreamType } from "effect";
import {
	Chunk,
	Clock,
	Effect,
	Fiber as FiberModule,
	Layer,
	Queue,
	Schema,
	Stream,
} from "effect";

export type CapabilityKind =
	| "diffSource"
	| "contextProvider"
	| "analyzer"
	| "agentRunner"
	| "cacheStore"
	| "promptPolicy";

export class EngineError extends Schema.TaggedError<EngineError>()(
	"EngineError",
	{
		code: Schema.Literal(
			"CapabilityUnavailable",
			"InvalidInput",
			"OperationFailed",
			"ProtocolViolation",
		),
		capabilityKind: Schema.optional(Schema.String),
		capabilityId: Schema.optional(Schema.String),
		message: Schema.String,
	},
) {}

export class EngineConfigError extends Schema.TaggedError<EngineConfigError>()(
	"EngineConfigError",
	{ message: Schema.String },
) {}

export interface EngineConfig {
	readonly diffSourceId: string;
	readonly analyzerId?: string;
	readonly agentRunnerId?: string;
	readonly cacheStoreId?: string;
	readonly promptPolicyId?: string;
	readonly contextProviderIds: ReadonlyArray<string>;
	readonly contextPolicy: ContextPolicy;
	readonly maxContextFragments: number;
	readonly maxContextCharacters: number;
}

export class EngineConfigService extends Effect.Tag("wth/EngineConfig")<
	EngineConfigService,
	EngineConfig
>() {}
export const makeEngineConfigLayer = (
	config: EngineConfig,
): Layer.Layer<EngineConfigService, EngineConfigError> =>
	Layer.effect(
		EngineConfigService,
		Effect.try({
			try: () => {
				if (config.diffSourceId.length === 0)
					throw new Error("diffSourceId must not be empty");
				if (
					!Number.isInteger(config.maxContextFragments) ||
					config.maxContextFragments < 0 ||
					!Number.isInteger(config.maxContextCharacters) ||
					config.maxContextCharacters < 0
				)
					throw new Error("context budgets must be non-negative integers");
				if (
					new Set(config.contextProviderIds).size !==
					config.contextProviderIds.length
				)
					throw new Error("contextProviderIds must be unique");
				Schema.decodeUnknownSync(ContextPolicySchema)(config.contextPolicy);
				return config;
			},
			catch: (error) => new EngineConfigError({ message: String(error) }),
		}),
	);

export interface ReviewEngineInputResolveDiff {
	readonly base: string;
	readonly head: string;
	readonly cwd: string;
	readonly path?: string;
}
export interface ReviewEngineInputExplain {
	readonly snapshot: DiffSnapshot;
	readonly hunkId: HunkId;
	readonly analyzer?: string;
	readonly contextPolicy?: ContextPolicy;
}
export interface ReviewEngineInputAsk {
	readonly snapshot: DiffSnapshot;
	readonly hunkId: HunkId;
	readonly question: string;
	readonly previousMessages?: ReadonlyArray<AgentMessage>;
	readonly runner?: string;
	readonly promptPolicy?: string;
	readonly model?: string;
	readonly agent?: string;
	readonly contextPolicy?: ContextPolicy;
}
export interface ReviewEngineInputReviewDiff {
	readonly snapshot: DiffSnapshot;
	readonly analyzer?: string;
}

export interface ReviewEngine {
	readonly resolveDiff: (
		input: ReviewEngineInputResolveDiff,
	) => Effect.Effect<DiffSnapshot, EngineError>;
	readonly explainHunk: (
		input: ReviewEngineInputExplain,
	) => Stream.Stream<ExplanationEvent, EngineError>;
	readonly askAboutHunk: (
		input: ReviewEngineInputAsk,
	) => Stream.Stream<AgentEvent, EngineError>;
	readonly reviewDiff: (
		input: ReviewEngineInputReviewDiff,
	) => Stream.Stream<ReviewAnalysisEvent, EngineError>;
}

export class ReviewEngineService extends Effect.Tag("wth/ReviewEngine")<
	ReviewEngineService,
	ReviewEngine
>() {}

type Signal =
	| { readonly _tag: "Value"; readonly value: unknown }
	| { readonly _tag: "Failure"; readonly error: EngineError }
	| { readonly _tag: "End" };

interface ActiveStream {
	readonly history: Array<unknown>;
	readonly subscribers: Set<QueueType.Queue<Signal>>;
	fiber?: Fiber.RuntimeFiber<void, never>;
}

const unavailable = (
	kind: CapabilityKind,
	id: string | undefined,
): EngineError =>
	new EngineError({
		code: "CapabilityUnavailable",
		capabilityKind: kind,
		...(id === undefined ? {} : { capabilityId: id }),
		message:
			id === undefined ? `no ${kind} configured` : `${kind} not found: ${id}`,
	});

const operationFailed = (
	kind: CapabilityKind,
	id: string,
	message: string,
): EngineError =>
	new EngineError({
		code: "OperationFailed",
		capabilityKind: kind,
		capabilityId: id,
		message,
	});

const hash = (value: unknown): string =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const makeReviewEngineLayer: Layer.Layer<
	ReviewEngineService,
	never,
	PluginRegistry | AnalysisSchedulerService | EngineConfigService
> = Layer.scoped(
	ReviewEngineService,
	Effect.gen(function* () {
		const registry = yield* PluginRegistry;
		const scheduler = yield* AnalysisSchedulerService;
		const config = yield* EngineConfigService;
		const serviceScope = yield* Effect.scope;
		const mutex = yield* Effect.makeSemaphore(1);
		const active = new Map<string, ActiveStream>();

		const findHunk = (
			snapshot: DiffSnapshot,
			hunkId: HunkId,
		): Effect.Effect<Hunk, EngineError> => {
			const hunk = snapshot.files
				.flatMap((file) => file.hunks)
				.find((candidate) => candidate.id === hunkId);
			return hunk === undefined
				? Effect.fail(
						new EngineError({
							code: "InvalidInput",
							message: `hunk not found: ${hunkId}`,
						}),
					)
				: Effect.succeed(hunk);
		};

		const validateContextPolicy = (
			policy: ContextPolicy,
		): Effect.Effect<ContextPolicy, EngineError> =>
			Effect.try({
				try: () => Schema.decodeUnknownSync(ContextPolicySchema)(policy),
				catch: (error) =>
					new EngineError({
						code: "InvalidInput",
						message: `invalid context policy: ${String(error)}`,
					}),
			});

		const collectContext = (
			snapshot: DiffSnapshot,
			hunk: Hunk,
			policy: ContextPolicy,
		): Effect.Effect<ReadonlyArray<ContextFragment>, EngineError> =>
			Effect.gen(function* () {
				const fragments: Array<ContextFragment> = [];
				let characters = 0;
				for (const providerId of config.contextProviderIds) {
					const provider = registry.contextProviders.get(providerId);
					if (provider === undefined)
						return yield* Effect.fail(
							unavailable("contextProvider", providerId),
						);
					const remaining = config.maxContextFragments - fragments.length;
					if (remaining <= 0 || characters >= config.maxContextCharacters)
						break;
					let providerCharacters = characters;
					const collected = yield* provider
						.collect({ snapshot, hunk, policy })
						.pipe(
							Stream.take(remaining),
							Stream.takeWhile((fragment) => {
								const next = providerCharacters + fragment.excerpt.length;
								if (next > config.maxContextCharacters) return false;
								providerCharacters = next;
								return true;
							}),
							Stream.mapError((error: ContextError) =>
								operationFailed(
									"contextProvider",
									error.capabilityId,
									error.message,
								),
							),
							Stream.runCollect,
						);
					const values = Chunk.toReadonlyArray(collected);
					fragments.push(...values);
					characters = providerCharacters;
				}
				return fragments;
			});

		const collectSnapshotContext = (
			snapshot: DiffSnapshot,
			policy: ContextPolicy,
		): Effect.Effect<ReadonlyArray<ContextFragment>, EngineError> =>
			Effect.gen(function* () {
				const fragments: Array<ContextFragment> = [];
				let characters = 0;
				outer: for (const file of snapshot.files) {
					for (const hunk of file.hunks) {
						const collected = yield* collectContext(snapshot, hunk, policy);
						for (const fragment of collected) {
							if (fragments.length >= config.maxContextFragments) break outer;
							const next = characters + fragment.excerpt.length;
							if (next > config.maxContextCharacters) break outer;
							fragments.push(fragment);
							characters = next;
						}
					}
				}
				return fragments;
			});

		const broadcast = <A>(input: {
			readonly key: string;
			readonly backend: string;
			readonly stream: StreamType.Stream<A, EngineError>;
		}): StreamType.Stream<A, EngineError> =>
			Stream.unwrapScoped(
				Effect.gen(function* () {
					const queue = yield* Queue.unbounded<Signal>();
					const registration = yield* mutex.withPermits(1)(
						Effect.sync(() => {
							const existing = active.get(input.key);
							if (existing !== undefined) {
								existing.subscribers.add(queue);
								for (const value of existing.history)
									Queue.unsafeOffer(queue, { _tag: "Value", value });
								return { current: existing, created: false } as const;
							}
							const current: ActiveStream = {
								history: [],
								subscribers: new Set([queue]),
							};
							active.set(input.key, current);
							return { current, created: true } as const;
						}),
					);

					if (registration.created) {
						const publish = (signal: Signal): Effect.Effect<void> =>
							mutex.withPermits(1)(
								Effect.sync(() => {
									if (signal._tag === "Value")
										registration.current.history.push(signal.value);
									for (const subscriber of registration.current.subscribers)
										Queue.unsafeOffer(subscriber, signal);
								}),
							);
						const run = scheduler
							.submit({
								key: input.key,
								backend: input.backend,
								priority: "visible",
								task: input.stream.pipe(
									Stream.runForEach((value) =>
										publish({ _tag: "Value", value }),
									),
								),
							})
							.pipe(
								Effect.matchEffect({
									onFailure: (error) => publish({ _tag: "Failure", error }),
									onSuccess: () => publish({ _tag: "End" }),
								}),
								Effect.ensuring(
									mutex.withPermits(1)(
										Effect.sync(() => {
											if (active.get(input.key) === registration.current)
												active.delete(input.key);
										}),
									),
								),
							);
						const fiber = yield* Effect.forkIn(run, serviceScope);
						yield* mutex.withPermits(1)(
							Effect.sync(() => {
								registration.current.fiber = fiber;
							}),
						);
					}

					yield* Effect.addFinalizer(() =>
						Effect.gen(function* () {
							const fiber = yield* mutex.withPermits(1)(
								Effect.sync(() => {
									registration.current.subscribers.delete(queue);
									return registration.current.subscribers.size === 0
										? registration.current.fiber
										: undefined;
								}),
							);
							if (fiber !== undefined) yield* FiberModule.interrupt(fiber);
						}),
					);

					return Stream.fromQueue(queue).pipe(
						Stream.takeWhile((signal) => signal._tag !== "End"),
						Stream.mapEffect((signal) =>
							signal._tag === "Failure"
								? Effect.fail(signal.error)
								: Effect.succeed(signal.value as A),
						),
					);
				}),
			);

		const resolveDiff = (
			input: ReviewEngineInputResolveDiff,
		): Effect.Effect<DiffSnapshot, EngineError> => {
			const source = registry.diffSources.get(config.diffSourceId);
			if (source === undefined)
				return Effect.fail(unavailable("diffSource", config.diffSourceId));
			return source
				.resolve({
					base: input.base,
					head: input.head,
					cwd: input.cwd,
					...(input.path === undefined
						? {}
						: { path: makeRepoPath(input.path) }),
				})
				.pipe(
					Effect.mapError((error: DiffError) =>
						operationFailed("diffSource", error.capabilityId, error.message),
					),
					Effect.flatMap((snapshot) =>
						Effect.try({
							try: () => decodeDiffSnapshot(snapshot),
							catch: (error) =>
								new EngineError({
									code: "ProtocolViolation",
									capabilityKind: "diffSource",
									capabilityId: source.id,
									message: String(error),
								}),
						}),
					),
				);
		};

		const explainHunk = (
			input: ReviewEngineInputExplain,
		): Stream.Stream<ExplanationEvent, EngineError> =>
			Stream.unwrap(
				Effect.gen(function* () {
					const hunk = yield* findHunk(input.snapshot, input.hunkId);
					const analyzerId = input.analyzer ?? config.analyzerId;
					if (analyzerId === undefined)
						return yield* Effect.fail(unavailable("analyzer", undefined));
					const analyzer = registry.analyzers.get(analyzerId);
					if (analyzer === undefined)
						return yield* Effect.fail(unavailable("analyzer", analyzerId));
					const policy = yield* validateContextPolicy(
						input.contextPolicy ?? config.contextPolicy,
					);
					const context = yield* collectContext(input.snapshot, hunk, policy);
					const providerVersions = config.contextProviderIds.map((id) => {
						const provider = registry.contextProviders.get(id);
						return [id, provider?.version];
					});
					const cacheKey = `explain:${hash({ snapshot: input.snapshot.id, hunk: hunk.id, analyzer: [analyzer.id, analyzer.version], providers: providerVersions, policy, context })}`;
					const cache =
						config.cacheStoreId === undefined
							? undefined
							: registry.cacheStores.get(config.cacheStoreId);
					if (config.cacheStoreId !== undefined && cache === undefined)
						return yield* Effect.fail(
							unavailable("cacheStore", config.cacheStoreId),
						);
					if (cache !== undefined) {
						const entry = yield* cache
							.get(cacheKey)
							.pipe(
								Effect.mapError((error: CacheError) =>
									operationFailed(
										"cacheStore",
										error.capabilityId,
										error.message,
									),
								),
							);
						if (entry._tag === "Some") {
							const decoded = yield* Effect.option(
								Effect.try({
									try: () =>
										decodeHunkExplanation(JSON.parse(entry.value.value)),
									catch: () => undefined,
								}),
							);
							if (decoded._tag === "Some")
								return Stream.succeed({
									_tag: "Complete",
									explanation: decoded.value,
								});
							yield* cache
								.delete(cacheKey)
								.pipe(
									Effect.mapError((error) =>
										operationFailed(
											"cacheStore",
											error.capabilityId,
											error.message,
										),
									),
								);
						}
					}

					let completion: HunkExplanation | undefined;
					let completionCount = 0;
					const validated = analyzer
						.analyze({ snapshot: input.snapshot, hunk, context })
						.pipe(
							Stream.mapEffect((event) =>
								Effect.try({
									try: () =>
										Schema.decodeUnknownSync(ExplanationEventSchema)(event),
									catch: (error) =>
										new EngineError({
											code: "ProtocolViolation",
											capabilityKind: "analyzer",
											capabilityId: analyzer.id,
											message: String(error),
										}),
								}),
							),
							Stream.tap((event) =>
								Effect.sync(() => {
									if (event._tag === "Complete") {
										completionCount += 1;
										completion = event.explanation;
									}
								}),
							),
							Stream.mapError((error) =>
								error instanceof EngineError
									? error
									: operationFailed(
											"analyzer",
											(error as AnalysisError).capabilityId,
											(error as AnalysisError).message,
										),
							),
						);
					const finalize = Effect.gen(function* () {
						if (completionCount !== 1 || completion === undefined) {
							return yield* Effect.fail(
								new EngineError({
									code: "ProtocolViolation",
									capabilityKind: "analyzer",
									capabilityId: analyzer.id,
									message: "analyzer must emit exactly one Complete event",
								}),
							);
						}
						if (cache !== undefined) {
							const now = yield* Clock.currentTimeMillis;
							yield* cache
								.set(cacheKey, {
									value: JSON.stringify(completion),
									storedAt: new Date(now).toISOString(),
								})
								.pipe(
									Effect.mapError((error) =>
										operationFailed(
											"cacheStore",
											error.capabilityId,
											error.message,
										),
									),
								);
						}
						return completion;
					});
					const output = validated.pipe(
						Stream.filter((event) => event._tag !== "Complete"),
						Stream.concat(
							Stream.fromEffect(finalize).pipe(
								Stream.map(
									(explanation): ExplanationEvent => ({
										_tag: "Complete",
										explanation,
									}),
								),
							),
						),
					);
					return broadcast({
						key: cacheKey,
						backend: analyzer.id,
						stream: output,
					});
				}),
			);

		const askAboutHunk = (
			input: ReviewEngineInputAsk,
		): Stream.Stream<AgentEvent, EngineError> =>
			Stream.unwrap(
				Effect.gen(function* () {
					const hunk = yield* findHunk(input.snapshot, input.hunkId);
					const runnerId = input.runner ?? config.agentRunnerId;
					if (runnerId === undefined)
						return yield* Effect.fail(unavailable("agentRunner", undefined));
					const runner = registry.agentRunners.get(runnerId);
					if (runner === undefined)
						return yield* Effect.fail(unavailable("agentRunner", runnerId));
					const contextPolicy = yield* validateContextPolicy(
						input.contextPolicy ?? config.contextPolicy,
					);
					const context = yield* collectContext(
						input.snapshot,
						hunk,
						contextPolicy,
					);
					const analyzeInput: AnalyzeInput = {
						snapshot: input.snapshot,
						hunk,
						context,
					};
					const policyId = input.promptPolicy ?? config.promptPolicyId;
					const promptPolicy =
						policyId === undefined
							? undefined
							: registry.promptPolicies.get(policyId);
					if (policyId !== undefined && promptPolicy === undefined)
						return yield* Effect.fail(unavailable("promptPolicy", policyId));
					const fallback = `${hunk.lines.map((line) => `${line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " "}${line.content}`).join("\n")}\n\nUser question: ${input.question}`;
					const prompt =
						promptPolicy?.buildQuestionPrompt(analyzeInput, input.question) ??
						fallback;
					const messages: ReadonlyArray<AgentMessage> = [
						...(input.previousMessages ?? []),
						{ role: "user", content: prompt },
					];
					const key = `ask:${hash({ hunk: hunk.id, runner: [runner.id, runner.version], messages, model: input.model, agent: input.agent })}`;
					return broadcast({
						key,
						backend: runner.id,
						stream: runner
							.run({
								messages,
								...(input.model === undefined ? {} : { model: input.model }),
								...(input.agent === undefined ? {} : { agent: input.agent }),
							})
							.pipe(
								Stream.mapError((error) =>
									operationFailed(
										"agentRunner",
										error.capabilityId,
										error.message,
									),
								),
							),
					});
				}),
			);

		const reviewDiff = (
			input: ReviewEngineInputReviewDiff,
		): Stream.Stream<ReviewAnalysisEvent, EngineError> =>
			Stream.unwrap(
				Effect.gen(function* () {
					const analyzerId = input.analyzer ?? config.analyzerId;
					if (analyzerId === undefined)
						return yield* Effect.fail(unavailable("analyzer", undefined));
					const analyzer: Analyzer | undefined =
						registry.analyzers.get(analyzerId);
					if (analyzer === undefined)
						return yield* Effect.fail(unavailable("analyzer", analyzerId));
					const review = analyzer.review;
					if (review === undefined)
						return yield* Effect.fail(unavailable("analyzer", analyzerId));

					const context = yield* collectSnapshotContext(
						input.snapshot,
						config.contextPolicy,
					);
					const key = `review:${hash({ snapshot: input.snapshot.id, analyzer: [analyzer.id, analyzer.version], context })}`;
					let completionCount = 0;
					const validated = review({ snapshot: input.snapshot, context }).pipe(
						Stream.mapEffect((event) =>
							Effect.try({
								try: () =>
									Schema.decodeUnknownSync(ReviewAnalysisEventSchema)(event),
								catch: (error) =>
									new EngineError({
										code: "ProtocolViolation",
										capabilityKind: "analyzer",
										capabilityId: analyzer.id,
										message: String(error),
									}),
							}),
						),
						Stream.tap((event) =>
							Effect.sync(() => {
								if (event._tag === "Complete") completionCount += 1;
							}),
						),
						Stream.mapError((error) =>
							error instanceof EngineError
								? error
								: operationFailed(
										"analyzer",
										(error as AnalysisError).capabilityId,
										(error as AnalysisError).message,
									),
						),
					);
					const output = validated.pipe(
						Stream.filter((event) => event._tag !== "Complete"),
						Stream.concat(
							Stream.fromEffect(
								Effect.suspend(() =>
									completionCount === 1
										? Effect.succeed({ _tag: "Complete" as const })
										: Effect.fail(
												new EngineError({
													code: "ProtocolViolation",
													capabilityKind: "analyzer",
													capabilityId: analyzer.id,
													message:
														"analyzer must emit exactly one Complete event",
												}),
											),
								),
							),
						),
					);
					return broadcast({ key, backend: analyzer.id, stream: output });
				}),
			);

		return { resolveDiff, explainHunk, askAboutHunk, reviewDiff };
	}),
);
