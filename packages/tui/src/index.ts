import { ReviewApiService } from "@bleentr/api";
import { ReviewEngineService } from "@bleentr/engine";
import type { PluginDefinition } from "@bleentr/plugin-api";
import {
	AgentRunners,
	Analyzers,
	CacheStores,
	capabilityLayers,
	DiffSources,
	PromptPolicies,
} from "@bleentr/plugin-api";
import { AnalysisSchedulerService } from "@bleentr/scheduler";
import type { CliRenderer } from "@opentui/core";
import { Context, Effect, Layer } from "effect";

export interface TuiDeps {
	readonly renderer: CliRenderer;
	readonly api: ReviewApiService;
}

// -- Runtime boundary ----------------------------------------------------------

export const reviewApiLayer = (
	plugins: ReadonlyArray<PluginDefinition>,
): Layer.Layer<ReviewApiService, never, never> => {
	const capabilityLayer = Layer.mergeAll(
		DiffSources.Default,
		Analyzers.Default,
		AgentRunners.Default,
		CacheStores.Default,
		PromptPolicies.Default,
		...plugins.map((plugin) => capabilityLayers(plugin.capabilities)),
	);
	// The scheduler forks its drain loop with `forkScoped`, so its construction
	// requires `Scope`. Build it inside its own layer scope — otherwise the
	// composed layer would force every consumer to run under `Effect.scoped`.
	const schedulerLayer = Layer.scoped(
		AnalysisSchedulerService,
		Effect.gen(function* () {
			const context = yield* Layer.build(AnalysisSchedulerService.Default);
			return Context.get(context, AnalysisSchedulerService);
		}),
	);
	const engineLayer = ReviewEngineService.DefaultWithoutDependencies.pipe(
		Layer.provide(capabilityLayer),
		Layer.provide(schedulerLayer),
	);
	return ReviewApiService.DefaultWithoutDependencies.pipe(
		Layer.provide(engineLayer),
	);
};

export const run = <A, E>(
	plugins: ReadonlyArray<PluginDefinition>,
	program: Effect.Effect<A, E, ReviewApiService>,
): Promise<A> =>
	Effect.runPromise(program.pipe(Effect.provide(reviewApiLayer(plugins))));

// -- Demo entry -----------------------------------------------------------------

export const demo = (
	base: string,
	head: string,
): Effect.Effect<
	{ readonly files: number; readonly firstSummary: string | undefined },
	never,
	ReviewApiService
> =>
	Effect.gen(function* () {
		const api = yield* ReviewApiService;
		const snapshot = yield* api
			.resolveDiff({ base, head })
			.pipe(Effect.catchAll(() => Effect.succeed(null)));
		if (snapshot === null) return { files: 0, firstSummary: undefined };
		const firstHunk = snapshot.files.find((f) => f.hunks.length > 0)?.hunks[0];
		if (!firstHunk) {
			return { files: snapshot.files.length, firstSummary: undefined };
		}
		const explanation = yield* api
			.explainHunk({ snapshot, hunkId: firstHunk.id })
			.pipe(Effect.catchAll(() => Effect.succeed(null)));
		return { files: snapshot.files.length, firstSummary: explanation?.summary };
	});
