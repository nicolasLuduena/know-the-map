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

/** The plugin API version a plugin targets. */
export const PLUGIN_API_VERSION = 1 as const;

// -- Shared schema types --------------------------------------------------------

/** Where a context fragment came from (LSP, search, git, ...). */
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

/** A symbol's basic info: name, kind, signature, and docs. */
export const SymbolInfoSchema = Schema.Struct({
	name: Schema.String,
	kind: Schema.String,
	signature: Schema.OptionFromUndefinedOr(Schema.String),
	documentation: Schema.OptionFromUndefinedOr(Schema.String),
});
export type SymbolInfo = Schema.Schema.Type<typeof SymbolInfoSchema>;

/** One piece of context for the analyzer, with why it matters. */
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
});
export type ContextFragment = Schema.Schema.Type<typeof ContextFragmentSchema>;

/** Limits and options for collecting context about a hunk. */
export const ContextPolicySchema = Schema.Struct({
	maxReferencesPerSymbol: Schema.Number,
	includeTests: Schema.Boolean,
	includeIncomingCalls: Schema.Boolean,
	includeOutgoingCalls: Schema.Boolean,
	traversalDepth: Schema.Number,
});
export type ContextPolicy = Schema.Schema.Type<typeof ContextPolicySchema>;

/** A cached value, with when it was stored and when it expires. */
export const CacheEntrySchema = Schema.Struct({
	value: Schema.String,
	storedAt: Schema.DateTimeUtc,
	expiresAt: Schema.OptionFromUndefinedOr(Schema.DateTimeUtc),
});
export type CacheEntry = Schema.Schema.Type<typeof CacheEntrySchema>;

/** A user's annotation on a hunk. */
export const AnnotationSchema = Schema.Struct({
	hunkId: HunkId,
	text: Schema.String,
	createdAt: Schema.DateTimeUtc,
});
export type Annotation = Schema.Schema.Type<typeof AnnotationSchema>;

/** Events an agent emits while running: text, tool calls, done. */
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

/** Something went wrong getting a diff. */
export class DiffError extends Schema.TaggedError<DiffError>()("DiffError", {
	message: Schema.String,
}) {}

/** Something went wrong collecting context. */
export class ContextError extends Schema.TaggedError<ContextError>()(
	"ContextError",
	{ message: Schema.String },
) {}

/** Something went wrong analyzing a hunk. */
export class AnalysisError extends Schema.TaggedError<AnalysisError>()(
	"AnalysisError",
	{ message: Schema.String },
) {}

/** Something went wrong running an agent. */
export class AgentRunnerError extends Schema.TaggedError<AgentRunnerError>()(
	"AgentRunnerError",
	{ message: Schema.String },
) {}

/** Something went wrong with the cache. */
export class CacheError extends Schema.TaggedError<CacheError>()("CacheError", {
	message: Schema.String,
}) {}

/** Something went wrong with the review store. */
export class ReviewStoreError extends Schema.TaggedError<ReviewStoreError>()(
	"ReviewStoreError",
	{ message: Schema.String },
) {}

// -- Capability: DiffSource ----------------------------------------------------

/** What a diff source needs to resolve a diff. */
export interface DiffSourceInput {
	readonly base: string;
	readonly head: string;
	readonly path?: RepoPath;
	readonly cwd?: string;
}

/** Where diffs come from (e.g. local git, a GitHub PR). */
export interface DiffSource {
	readonly id: string;
	readonly resolve: (
		input: DiffSourceInput,
	) => Effect.Effect<DiffSnapshot, DiffError>;
}

// -- Capability: ContextProvider -------------------------------------------------

/** What a context provider needs to collect context. */
export interface ContextRequest {
	readonly hunk: Hunk;
	readonly policy: ContextPolicy;
}

/** Provides extra context about a hunk (e.g. LSP). Emits fragments in
 * descending order of value: stream order is the ranking, and the consumer
 * truncates at its budget. */
export interface ContextProvider {
	readonly id: string;
	readonly collect: (
		request: ContextRequest,
	) => Stream.Stream<ContextFragment, ContextError>;
}

// -- Capability: Analyzer ---------------------------------------------------------

/** What an analyzer needs to explain a hunk. */
export interface AnalyzeInput {
	readonly hunk: Hunk;
	readonly context: ReadonlyArray<ContextFragment>;
}

/** Explains or reviews a hunk. */
export interface Analyzer {
	readonly id: string;
	readonly analyze: (
		input: AnalyzeInput,
	) => Effect.Effect<HunkExplanation, AnalysisError>;
}

// -- Capability: AgentRunner --------------------------------------------------------

/** What an agent runner can do: streaming, tools, and context size. */
export interface AgentCapabilities {
	readonly streaming: boolean;
	readonly tools: boolean;
	readonly maxContextTokens: number;
}

/** What an agent runner needs to run. */
export interface AgentRequest {
	readonly prompt: string;
	readonly system?: string;
	readonly model?: string;
}

/** Runs an agent (e.g. OpenCode). */
export interface AgentRunner {
	readonly id: string;
	readonly capabilities: AgentCapabilities;
	readonly run: (
		request: AgentRequest,
	) => Stream.Stream<AgentEvent, AgentRunnerError>;
}

// -- Capability: CacheStore ----------------------------------------------------------

/** Stores cached results (e.g. SQLite, memory). */
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

/** Stores review state: viewed hunks and annotations. */
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

/** Builds prompts for analyzers and agents. */
export interface PromptPolicy {
	readonly id: string;
	readonly buildPrompt: (input: AnalyzeInput) => string;
}

// -- Capability: LanguageServerDefinition -------------------------------------------------

/** Declares a language server to launch. */
export interface LanguageServerDefinition {
	readonly id: string;
	readonly languages: ReadonlyArray<string>;
	readonly command: ReadonlyArray<string>;
}

// -- Aggregate service tags ------------------------------------------------------------
// Registered plugins, grouped by capability. The engine reads these; plugins fill them.

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

/** Every service a plugin can fill, as one union. */
export type CapabilityServices =
	| DiffSources
	| ContextProviders
	| Analyzers
	| AgentRunners
	| CacheStores
	| ReviewStores
	| PromptPolicies
	| LanguageServerDefinitions;

/** Turns a plugin's capabilities into a layer the engine can consume. */
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

/** What a plugin can contribute. All parts are optional. */
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

/** A plugin's declaration: id, API version, and capabilities. */
export interface PluginDefinition<
	C extends PluginCapabilities = PluginCapabilities,
> {
	readonly id: string;
	readonly apiVersion: typeof PLUGIN_API_VERSION;
	readonly capabilities: C;
}

/** Type-checks a plugin declaration against the capability contracts. */
export function definePlugin<C extends PluginCapabilities>(
	plugin: PluginDefinition<C>,
): PluginDefinition<C> {
	return plugin;
}
