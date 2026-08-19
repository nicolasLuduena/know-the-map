import type { DiffSnapshot, Hunk, HunkId, RepoPath } from "@bleentr/domain";
import {
	HunkExplanationSchema,
	HunkId as HunkIdSchema,
	ReviewFindingSchema,
} from "@bleentr/domain";
import type { Option, Scope, Stream } from "effect";
import { Effect, Layer, Schema } from "effect";

export const PLUGIN_API_VERSION = 1 as const;
export type PluginApiVersion = typeof PLUGIN_API_VERSION;

export interface CapabilityMetadata {
	readonly id: string;
	/** Bump whenever behavior that participates in cached output changes. */
	readonly version: string;
}

const UtcTimestamp = Schema.String.pipe(
	Schema.filter((value) => !Number.isNaN(Date.parse(value)), {
		message: () => "expected an ISO-8601 timestamp",
	}),
);

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
	signature: Schema.optional(Schema.String),
	documentation: Schema.optional(Schema.String),
});
export type SymbolInfo = Schema.Schema.Type<typeof SymbolInfoSchema>;

export const ContextFragmentSchema = Schema.Struct({
	id: Schema.String,
	source: ContextFragmentSourceSchema,
	uri: Schema.String,
	range: Schema.optional(
		Schema.Struct({
			start: Schema.Struct({
				line: Schema.NonNegativeInt,
				character: Schema.NonNegativeInt,
			}),
			end: Schema.Struct({
				line: Schema.NonNegativeInt,
				character: Schema.NonNegativeInt,
			}),
		}),
	),
	symbol: Schema.optional(SymbolInfoSchema),
	excerpt: Schema.String,
	reason: Schema.String,
});
export type ContextFragment = Schema.Schema.Type<typeof ContextFragmentSchema>;

export const ContextPolicySchema = Schema.Struct({
	maxReferencesPerSymbol: Schema.NonNegativeInt,
	includeTests: Schema.Boolean,
	includeIncomingCalls: Schema.Boolean,
	includeOutgoingCalls: Schema.Boolean,
	traversalDepth: Schema.NonNegativeInt,
});
export type ContextPolicy = Schema.Schema.Type<typeof ContextPolicySchema>;

export const CacheEntrySchema = Schema.Struct({
	value: Schema.String,
	storedAt: UtcTimestamp,
	expiresAt: Schema.optional(UtcTimestamp),
});
export type CacheEntry = Schema.Schema.Type<typeof CacheEntrySchema>;

export const AnnotationSchema = Schema.Struct({
	hunkId: HunkIdSchema,
	text: Schema.String,
	createdAt: UtcTimestamp,
});
export type Annotation = Schema.Schema.Type<typeof AnnotationSchema>;

export const AgentMessageSchema = Schema.Struct({
	role: Schema.Literal("system", "user", "assistant"),
	content: Schema.String,
});
export type AgentMessage = Schema.Schema.Type<typeof AgentMessageSchema>;

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

export const ExplanationEventSchema = Schema.Union(
	Schema.Struct({ _tag: Schema.Literal("Text"), text: Schema.String }),
	Schema.Struct({
		_tag: Schema.Literal("Complete"),
		explanation: HunkExplanationSchema,
	}),
);
export type ExplanationEvent = Schema.Schema.Type<
	typeof ExplanationEventSchema
>;

export const ReviewAnalysisEventSchema = Schema.Union(
	Schema.Struct({ _tag: Schema.Literal("Text"), text: Schema.String }),
	Schema.Struct({
		_tag: Schema.Literal("Finding"),
		finding: ReviewFindingSchema,
	}),
	Schema.Struct({ _tag: Schema.Literal("Complete") }),
);
export type ReviewAnalysisEvent = Schema.Schema.Type<
	typeof ReviewAnalysisEventSchema
>;

export class DiffError extends Schema.TaggedError<DiffError>()("DiffError", {
	capabilityId: Schema.String,
	message: Schema.String,
}) {}
export class ContextError extends Schema.TaggedError<ContextError>()(
	"ContextError",
	{
		capabilityId: Schema.String,
		message: Schema.String,
	},
) {}
export class AnalysisError extends Schema.TaggedError<AnalysisError>()(
	"AnalysisError",
	{
		capabilityId: Schema.String,
		message: Schema.String,
	},
) {}
export class AgentRunnerError extends Schema.TaggedError<AgentRunnerError>()(
	"AgentRunnerError",
	{
		capabilityId: Schema.String,
		message: Schema.String,
	},
) {}
export class CacheError extends Schema.TaggedError<CacheError>()("CacheError", {
	capabilityId: Schema.String,
	message: Schema.String,
}) {}
export class ReviewStoreError extends Schema.TaggedError<ReviewStoreError>()(
	"ReviewStoreError",
	{
		capabilityId: Schema.String,
		message: Schema.String,
	},
) {}
export class PluginInitError extends Schema.TaggedError<PluginInitError>()(
	"PluginInitError",
	{
		pluginId: Schema.String,
		message: Schema.String,
	},
) {}

export interface DiffSourceInput {
	readonly base: string;
	readonly head: string;
	readonly path?: RepoPath;
	readonly cwd: string;
}
export interface DiffSource extends CapabilityMetadata {
	readonly resolve: (
		input: DiffSourceInput,
	) => Effect.Effect<DiffSnapshot, DiffError>;
}

export interface ContextRequest {
	readonly snapshot: DiffSnapshot;
	readonly hunk: Hunk;
	readonly policy: ContextPolicy;
}
export interface ContextProvider extends CapabilityMetadata {
	readonly collect: (
		request: ContextRequest,
	) => Stream.Stream<ContextFragment, ContextError>;
}

export interface AnalyzeInput {
	readonly snapshot: DiffSnapshot;
	readonly hunk: Hunk;
	readonly context: ReadonlyArray<ContextFragment>;
}
export interface ReviewInput {
	readonly snapshot: DiffSnapshot;
	readonly context: ReadonlyArray<ContextFragment>;
}
export interface Analyzer extends CapabilityMetadata {
	readonly analyze: (
		input: AnalyzeInput,
	) => Stream.Stream<ExplanationEvent, AnalysisError>;
	readonly review?: (
		input: ReviewInput,
	) => Stream.Stream<ReviewAnalysisEvent, AnalysisError>;
}

export interface AgentCapabilities {
	readonly streaming: boolean;
	readonly tools: boolean;
	readonly maxContextTokens: number;
}
export interface AgentRequest {
	readonly messages: ReadonlyArray<AgentMessage>;
	readonly model?: string;
	readonly agent?: string;
}
export interface AgentRunner extends CapabilityMetadata {
	readonly capabilities: AgentCapabilities;
	readonly run: (
		request: AgentRequest,
	) => Stream.Stream<AgentEvent, AgentRunnerError>;
}

export interface CacheStore extends CapabilityMetadata {
	readonly get: (
		key: string,
	) => Effect.Effect<Option.Option<CacheEntry>, CacheError>;
	readonly set: (
		key: string,
		entry: CacheEntry,
	) => Effect.Effect<void, CacheError>;
	readonly delete: (key: string) => Effect.Effect<void, CacheError>;
}

export interface ReviewStore extends CapabilityMetadata {
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

export interface PromptPolicy extends CapabilityMetadata {
	readonly buildPrompt: (input: AnalyzeInput) => string;
	readonly buildQuestionPrompt: (
		input: AnalyzeInput,
		question: string,
	) => string;
}

export interface LanguageServerDefinition extends CapabilityMetadata {
	readonly languages: ReadonlyArray<string>;
	readonly command: ReadonlyArray<string>;
}

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

export interface PluginDefinition {
	readonly id: string;
	readonly version: string;
	readonly apiVersion: PluginApiVersion;
	readonly build: Effect.Effect<
		PluginCapabilities,
		PluginInitError,
		Scope.Scope
	>;
}

export const definePlugin = (plugin: PluginDefinition): PluginDefinition =>
	plugin;

type CapabilityKind = keyof PluginCapabilities;
const capabilityKinds: ReadonlyArray<CapabilityKind> = [
	"diffSources",
	"contextProviders",
	"analyzers",
	"agentRunners",
	"cacheStores",
	"reviewStores",
	"promptPolicies",
	"languageServerDefinitions",
];

export interface PluginRegistryShape {
	readonly plugins: ReadonlyMap<
		string,
		{ readonly id: string; readonly version: string }
	>;
	readonly diffSources: ReadonlyMap<string, DiffSource>;
	readonly contextProviders: ReadonlyMap<string, ContextProvider>;
	readonly analyzers: ReadonlyMap<string, Analyzer>;
	readonly agentRunners: ReadonlyMap<string, AgentRunner>;
	readonly cacheStores: ReadonlyMap<string, CacheStore>;
	readonly reviewStores: ReadonlyMap<string, ReviewStore>;
	readonly promptPolicies: ReadonlyMap<string, PromptPolicy>;
	readonly languageServerDefinitions: ReadonlyMap<
		string,
		LanguageServerDefinition
	>;
}

export class PluginRegistry extends Effect.Tag("wth/PluginRegistry")<
	PluginRegistry,
	PluginRegistryShape
>() {}

const addCapabilities = <A extends CapabilityMetadata>(
	pluginId: string,
	kind: string,
	target: Map<string, A>,
	values: ReadonlyArray<A> | undefined,
): Effect.Effect<void, PluginInitError> =>
	Effect.forEach(values ?? [], (value) =>
		target.has(value.id)
			? Effect.fail(
					new PluginInitError({
						pluginId,
						message: `duplicate ${kind} capability id: ${value.id}`,
					}),
				)
			: Effect.sync(() => target.set(value.id, value)),
	).pipe(Effect.asVoid);

export const makePluginRegistryLayer = (
	definitions: ReadonlyArray<PluginDefinition>,
): Layer.Layer<PluginRegistry, PluginInitError> =>
	Layer.scoped(
		PluginRegistry,
		Effect.gen(function* () {
			const pluginIds = new Set<string>();
			const built: Array<readonly [PluginDefinition, PluginCapabilities]> = [];
			for (const definition of definitions) {
				if (pluginIds.has(definition.id)) {
					return yield* Effect.fail(
						new PluginInitError({
							pluginId: definition.id,
							message: "duplicate plugin id",
						}),
					);
				}
				if (definition.apiVersion !== PLUGIN_API_VERSION) {
					return yield* Effect.fail(
						new PluginInitError({
							pluginId: definition.id,
							message: `unsupported plugin API version: ${definition.apiVersion}`,
						}),
					);
				}
				pluginIds.add(definition.id);
				built.push([definition, yield* definition.build]);
			}

			const registry = {
				plugins: new Map<
					string,
					{ readonly id: string; readonly version: string }
				>(),
				diffSources: new Map<string, DiffSource>(),
				contextProviders: new Map<string, ContextProvider>(),
				analyzers: new Map<string, Analyzer>(),
				agentRunners: new Map<string, AgentRunner>(),
				cacheStores: new Map<string, CacheStore>(),
				reviewStores: new Map<string, ReviewStore>(),
				promptPolicies: new Map<string, PromptPolicy>(),
				languageServerDefinitions: new Map<string, LanguageServerDefinition>(),
			};
			for (const [definition, capabilities] of built) {
				registry.plugins.set(definition.id, {
					id: definition.id,
					version: definition.version,
				});
				for (const kind of capabilityKinds) {
					yield* addCapabilities(
						definition.id,
						kind,
						registry[kind] as Map<string, CapabilityMetadata>,
						capabilities[kind] as ReadonlyArray<CapabilityMetadata> | undefined,
					);
				}
			}
			return registry;
		}),
	);
