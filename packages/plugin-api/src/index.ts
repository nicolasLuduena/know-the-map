import type {
	DiffSnapshot,
	Hunk,
	HunkExplanation,
	RepoPath,
} from "@bleentr/domain";
import { HunkId } from "@bleentr/domain";
import type { Option, Stream } from "effect";
import { Effect, Layer, Schema } from "effect";

// -- Versioned plugin boundary ------------------------------------------------

export const PLUGIN_API_VERSION = 1 as const;

// -- Shared schema types --------------------------------------------------------

export const ContextFragmentSourceSchema = Schema.Literal(
	"lsp.reference",
	"lsp.call",
	"lsp.hover",
	"syntax",
	"search",
	"git",
);
export type ContextFragmentSource = Schema.Schema.Type<
	typeof ContextFragmentSourceSchema
>;

export const SymbolInfoSchema = Schema.Struct({
	name: Schema.String,
	kind: Schema.String,
	signature: Schema.OptionFromUndefinedOr(Schema.String),
	documentation: Schema.OptionFromUndefinedOr(Schema.String),
});
export type SymbolInfo = Schema.Schema.Type<typeof SymbolInfoSchema>;

export const ContextFragmentSchema = Schema.Struct({
	id: Schema.String,
	source: ContextFragmentSourceSchema,
	uri: Schema.String,
	range: Schema.OptionFromUndefinedOr(
		Schema.Struct({
			start: Schema.Struct({
				line: Schema.Number,
				character: Schema.Number,
			}),
			end: Schema.Struct({
				line: Schema.Number,
				character: Schema.Number,
			}),
		}),
	),
	symbol: Schema.OptionFromUndefinedOr(SymbolInfoSchema),
	excerpt: Schema.String,
	reason: Schema.String,
	relevance: Schema.Number,
	estimatedTokens: Schema.Number,
});
export type ContextFragment = Schema.Schema.Type<typeof ContextFragmentSchema>;

export const ContextPolicySchema = Schema.Struct({
	maxTokens: Schema.Number,
	maxReferencesPerSymbol: Schema.Number,
	includeTests: Schema.Boolean,
	includeIncomingCalls: Schema.Boolean,
	includeOutgoingCalls: Schema.Boolean,
	traversalDepth: Schema.Number,
});
export type ContextPolicy = Schema.Schema.Type<typeof ContextPolicySchema>;

export const CacheEntrySchema = Schema.Struct({
	value: Schema.String,
	storedAt: Schema.DateTimeUtc,
	expiresAt: Schema.OptionFromUndefinedOr(Schema.DateTimeUtc),
});
export type CacheEntry = Schema.Schema.Type<typeof CacheEntrySchema>;

export const AnnotationSchema = Schema.Struct({
	hunkId: HunkId,
	text: Schema.String,
	createdAt: Schema.DateTimeUtc,
});
export type Annotation = Schema.Schema.Type<typeof AnnotationSchema>;

export const AgentEventSchema = Schema.Union(
	Schema.Struct({ _tag: Schema.Literal("Text"), text: Schema.String }),
	Schema.Struct({
		_tag: Schema.Literal("ToolCall"),
		name: Schema.String,
		input: Schema.String,
	}),
	Schema.Struct({ _tag: Schema.Literal("Done"), output: Schema.String }),
);
export type AgentEvent = Schema.Schema.Type<typeof AgentEventSchema>;

// -- Capability errors -----------------------------------------------------------

export class DiffError extends Schema.TaggedError<DiffError>()("DiffError", {
	message: Schema.String,
}) {}

export class ContextError extends Schema.TaggedError<ContextError>()(
	"ContextError",
	{ message: Schema.String },
) {}

export class AnalysisError extends Schema.TaggedError<AnalysisError>()(
	"AnalysisError",
	{ message: Schema.String },
) {}

export class AgentRunnerError extends Schema.TaggedError<AgentRunnerError>()(
	"AgentRunnerError",
	{ message: Schema.String },
) {}

export class CacheError extends Schema.TaggedError<CacheError>()("CacheError", {
	message: Schema.String,
}) {}

export class ReviewStoreError extends Schema.TaggedError<ReviewStoreError>()(
	"ReviewStoreError",
	{ message: Schema.String },
) {}

// -- Capability: DiffSource ----------------------------------------------------

export interface DiffSourceInput {
	readonly base: string;
	readonly head: string;
	readonly path?: RepoPath;
	readonly cwd?: string;
}

export interface DiffSource {
	readonly id: string;
	readonly resolve: (
		input: DiffSourceInput,
	) => Effect.Effect<DiffSnapshot, DiffError>;
}

// -- Capability: ContextProvider -------------------------------------------------

export interface ContextRequest {
	readonly hunk: Hunk;
	readonly policy: ContextPolicy;
}

export interface ContextProvider {
	readonly id: string;
	readonly collect: (
		request: ContextRequest,
	) => Stream.Stream<ContextFragment, ContextError>;
}

// -- Capability: Analyzer ---------------------------------------------------------

export interface AnalyzeInput {
	readonly hunk: Hunk;
	readonly context: ReadonlyArray<ContextFragment>;
}

export interface Analyzer {
	readonly id: string;
	readonly analyze: (
		input: AnalyzeInput,
	) => Effect.Effect<HunkExplanation, AnalysisError>;
}

// -- Capability: AgentRunner --------------------------------------------------------

export interface AgentCapabilities {
	readonly streaming: boolean;
	readonly tools: boolean;
	readonly maxContextTokens: number;
}

export interface AgentRequest {
	readonly prompt: string;
	readonly system?: string;
	readonly model?: string;
}

export interface AgentRunner {
	readonly id: string;
	readonly capabilities: AgentCapabilities;
	readonly run: (
		request: AgentRequest,
	) => Stream.Stream<AgentEvent, AgentRunnerError>;
}

// -- Capability: CacheStore ----------------------------------------------------------

export interface CacheStore {
	readonly id: string;
	readonly get: (
		key: string,
	) => Effect.Effect<Option.Option<CacheEntry>, CacheError>;
	readonly set: (
		key: string,
		entry: CacheEntry,
	) => Effect.Effect<void, CacheError>;
	readonly delete: (key: string) => Effect.Effect<void, CacheError>;
}

// -- Capability: ReviewStore -----------------------------------------------------------

export interface ReviewStore {
	readonly id: string;
	readonly markViewed: (
		hunkId: HunkId,
	) => Effect.Effect<void, ReviewStoreError>;
	readonly isViewed: (
		hunkId: HunkId,
	) => Effect.Effect<boolean, ReviewStoreError>;
	readonly saveAnnotation: (
		annotation: Annotation,
	) => Effect.Effect<void, ReviewStoreError>;
	readonly annotations: (
		hunkId: HunkId,
	) => Effect.Effect<ReadonlyArray<Annotation>, ReviewStoreError>;
}

// -- Capability: PromptPolicy ------------------------------------------------------------

export interface PromptPolicy {
	readonly id: string;
	readonly buildPrompt: (input: AnalyzeInput) => string;
}

// -- Capability: LanguageServerDefinition -------------------------------------------------

export interface LanguageServerDefinition {
	readonly id: string;
	readonly languages: ReadonlyArray<string>;
	readonly command: ReadonlyArray<string>;
}

// -- Aggregate service tags ------------------------------------------------------------

export class DiffSources extends Effect.Service<DiffSources>()(
	"wth/DiffSources",
	{
		succeed: [] as ReadonlyArray<DiffSource>,
	},
) {}

export class ContextProviders extends Effect.Service<ContextProviders>()(
	"wth/ContextProviders",
	{
		succeed: [] as ReadonlyArray<ContextProvider>,
	},
) {}

export class Analyzers extends Effect.Service<Analyzers>()("wth/Analyzers", {
	succeed: [] as ReadonlyArray<Analyzer>,
}) {}

export class AgentRunners extends Effect.Service<AgentRunners>()(
	"wth/AgentRunners",
	{
		succeed: [] as ReadonlyArray<AgentRunner>,
	},
) {}

export class CacheStores extends Effect.Service<CacheStores>()(
	"wth/CacheStores",
	{
		succeed: [] as ReadonlyArray<CacheStore>,
	},
) {}

export class ReviewStores extends Effect.Service<ReviewStores>()(
	"wth/ReviewStores",
	{
		succeed: [] as ReadonlyArray<ReviewStore>,
	},
) {}

export class PromptPolicies extends Effect.Service<PromptPolicies>()(
	"wth/PromptPolicies",
	{
		succeed: [] as ReadonlyArray<PromptPolicy>,
	},
) {}

export class LanguageServerDefinitions extends Effect.Service<LanguageServerDefinitions>()(
	"wth/LanguageServerDefinitions",
	{
		succeed: [] as ReadonlyArray<LanguageServerDefinition>,
	},
) {}

export type CapabilityServices =
	| DiffSources
	| ContextProviders
	| Analyzers
	| AgentRunners
	| CacheStores
	| ReviewStores
	| PromptPolicies
	| LanguageServerDefinitions;

export const capabilityLayers = (
	capabilities: PluginCapabilities,
): Layer.Layer<CapabilityServices> =>
	Layer.mergeAll(
		Layer.succeed(DiffSources, new DiffSources(capabilities.diffSources ?? [])),
		Layer.succeed(
			ContextProviders,
			new ContextProviders(capabilities.contextProviders ?? []),
		),
		Layer.succeed(Analyzers, new Analyzers(capabilities.analyzers ?? [])),
		Layer.succeed(
			AgentRunners,
			new AgentRunners(capabilities.agentRunners ?? []),
		),
		Layer.succeed(CacheStores, new CacheStores(capabilities.cacheStores ?? [])),
		Layer.succeed(
			ReviewStores,
			new ReviewStores(capabilities.reviewStores ?? []),
		),
		Layer.succeed(
			PromptPolicies,
			new PromptPolicies(capabilities.promptPolicies ?? []),
		),
		Layer.succeed(
			LanguageServerDefinitions,
			new LanguageServerDefinitions(
				capabilities.languageServerDefinitions ?? [],
			),
		),
	);

// -- Plugin definition ----------------------------------------------------------------------

export interface PluginCapabilities {
	readonly diffSources?: ReadonlyArray<DiffSource>;
	readonly contextProviders?: ReadonlyArray<ContextProvider>;
	readonly analyzers?: ReadonlyArray<Analyzer>;
	readonly agentRunners?: ReadonlyArray<AgentRunner>;
	readonly cacheStores?: ReadonlyArray<CacheStore>;
	readonly reviewStores?: ReadonlyArray<ReviewStore>;
	readonly promptPolicies?: ReadonlyArray<PromptPolicy>;
	readonly languageServerDefinitions?: ReadonlyArray<LanguageServerDefinition>;
}

export interface PluginDefinition<
	C extends PluginCapabilities = PluginCapabilities,
> {
	readonly id: string;
	readonly apiVersion: typeof PLUGIN_API_VERSION;
	readonly capabilities: C;
}

export function definePlugin<C extends PluginCapabilities>(
	plugin: PluginDefinition<C>,
): PluginDefinition<C> {
	return plugin;
}
