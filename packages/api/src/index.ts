import type { DiffSnapshot } from "@bleentr/domain";
import {
	DiffSnapshotSchema,
	HunkExplanationSchema,
	HunkId,
	ReviewFindingSchema,
} from "@bleentr/domain";
import type { ReviewEngine } from "@bleentr/engine";
import { type EngineError, ReviewEngineService } from "@bleentr/engine";
import { Effect, Layer, Schema, Stream } from "effect";

const ApiErrorCode = Schema.Literal(
	"CapabilityUnavailable",
	"InvalidInput",
	"OperationFailed",
	"ProtocolViolation",
);

export class DiffError extends Schema.TaggedError<DiffError>()("DiffError", {
	code: ApiErrorCode,
	capabilityId: Schema.optional(Schema.String),
	message: Schema.String,
}) {}
export class AnalysisError extends Schema.TaggedError<AnalysisError>()(
	"AnalysisError",
	{
		code: ApiErrorCode,
		capabilityId: Schema.optional(Schema.String),
		message: Schema.String,
	},
) {}
export class ReviewError extends Schema.TaggedError<ReviewError>()(
	"ReviewError",
	{
		code: ApiErrorCode,
		capabilityId: Schema.optional(Schema.String),
		message: Schema.String,
	},
) {}

export const ContextPolicyInputSchema = Schema.Struct({
	maxReferencesPerSymbol: Schema.NonNegativeInt,
	includeTests: Schema.Boolean,
	includeIncomingCalls: Schema.Boolean,
	includeOutgoingCalls: Schema.Boolean,
	traversalDepth: Schema.NonNegativeInt,
});
export type ContextPolicyInput = Schema.Schema.Type<
	typeof ContextPolicyInputSchema
>;

export const ResolveDiffInputSchema = Schema.Struct({
	base: Schema.String.pipe(Schema.minLength(1)),
	head: Schema.String.pipe(Schema.minLength(1)),
	cwd: Schema.String.pipe(Schema.minLength(1)),
	path: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
});
export type ResolveDiffInput = Schema.Schema.Type<
	typeof ResolveDiffInputSchema
>;

export const MessageSchema = Schema.Struct({
	role: Schema.Literal("user", "assistant"),
	content: Schema.String,
});
export type Message = Schema.Schema.Type<typeof MessageSchema>;

export const ExplainHunkInputSchema = Schema.Struct({
	snapshot: DiffSnapshotSchema,
	hunkId: HunkId,
	contextPolicy: Schema.optional(ContextPolicyInputSchema),
	analyzer: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
});
export type ExplainHunkInput = Schema.Schema.Type<
	typeof ExplainHunkInputSchema
>;

export const AskAboutHunkInputSchema = Schema.Struct({
	snapshot: DiffSnapshotSchema,
	hunkId: HunkId,
	question: Schema.String.pipe(Schema.minLength(1)),
	previousMessages: Schema.optional(Schema.Array(MessageSchema)),
	contextPolicy: Schema.optional(ContextPolicyInputSchema),
	runner: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
	promptPolicy: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
	model: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
	agent: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
});
export type AskAboutHunkInput = Schema.Schema.Type<
	typeof AskAboutHunkInputSchema
>;

export const ReviewDiffInputSchema = Schema.Struct({
	snapshot: DiffSnapshotSchema,
	analyzer: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
});
export type ReviewDiffInput = Schema.Schema.Type<typeof ReviewDiffInputSchema>;

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

export const AnswerEventSchema = Schema.Union(
	Schema.Struct({ _tag: Schema.Literal("Text"), text: Schema.String }),
	Schema.Struct({
		_tag: Schema.Literal("ToolCall"),
		name: Schema.String,
		input: Schema.String,
	}),
	Schema.Struct({ _tag: Schema.Literal("Done"), answer: Schema.String }),
);
export type AnswerEvent = Schema.Schema.Type<typeof AnswerEventSchema>;

export const ReviewEventSchema = Schema.Union(
	Schema.Struct({ _tag: Schema.Literal("Text"), text: Schema.String }),
	Schema.Struct({
		_tag: Schema.Literal("Finding"),
		finding: ReviewFindingSchema,
	}),
	Schema.Struct({ _tag: Schema.Literal("Complete") }),
);
export type ReviewEvent = Schema.Schema.Type<typeof ReviewEventSchema>;

export interface ReviewApi {
	readonly resolveDiff: (
		input: ResolveDiffInput,
	) => Effect.Effect<DiffSnapshot, DiffError>;
	readonly explainHunk: (
		input: ExplainHunkInput,
	) => Stream.Stream<ExplanationEvent, AnalysisError>;
	readonly askAboutHunk: (
		input: AskAboutHunkInput,
	) => Stream.Stream<AnswerEvent, AnalysisError>;
	readonly reviewDiff: (
		input: ReviewDiffInput,
	) => Stream.Stream<ReviewEvent, ReviewError>;
}

export class ReviewApiService extends Effect.Tag("wth/ReviewApi")<
	ReviewApiService,
	ReviewApi
>() {}

const fields = (error: EngineError) => ({
	code: error.code,
	...(error.capabilityId === undefined
		? {}
		: { capabilityId: error.capabilityId }),
	message: error.message,
});

export const makeReviewApiLayer: Layer.Layer<
	ReviewApiService,
	never,
	ReviewEngineService
> = Layer.effect(
	ReviewApiService,
	Effect.gen(function* () {
		const engine: ReviewEngine = yield* ReviewEngineService;
		return {
			resolveDiff: (input) =>
				engine
					.resolveDiff({
						base: input.base,
						head: input.head,
						cwd: input.cwd,
						...(input.path === undefined ? {} : { path: input.path }),
					})
					.pipe(Effect.mapError((error) => new DiffError(fields(error)))),
			explainHunk: (input) =>
				engine
					.explainHunk({
						snapshot: input.snapshot,
						hunkId: input.hunkId,
						...(input.contextPolicy === undefined
							? {}
							: { contextPolicy: input.contextPolicy }),
						...(input.analyzer === undefined
							? {}
							: { analyzer: input.analyzer }),
					})
					.pipe(
						Stream.mapError((error) => new AnalysisError(fields(error))),
						Stream.map((event): ExplanationEvent => event),
					),
			askAboutHunk: (input) =>
				engine
					.askAboutHunk({
						snapshot: input.snapshot,
						hunkId: input.hunkId,
						question: input.question,
						...(input.previousMessages === undefined
							? {}
							: { previousMessages: input.previousMessages }),
						...(input.contextPolicy === undefined
							? {}
							: { contextPolicy: input.contextPolicy }),
						...(input.runner === undefined ? {} : { runner: input.runner }),
						...(input.promptPolicy === undefined
							? {}
							: { promptPolicy: input.promptPolicy }),
						...(input.model === undefined ? {} : { model: input.model }),
						...(input.agent === undefined ? {} : { agent: input.agent }),
					})
					.pipe(
						Stream.mapError((error) => new AnalysisError(fields(error))),
						Stream.map(
							(event): AnswerEvent =>
								event._tag === "Done"
									? { _tag: "Done", answer: event.output }
									: event,
						),
					),
			reviewDiff: (input) =>
				engine
					.reviewDiff({
						snapshot: input.snapshot,
						...(input.analyzer === undefined
							? {}
							: { analyzer: input.analyzer }),
					})
					.pipe(
						Stream.mapError((error) => new ReviewError(fields(error))),
						Stream.map((event): ReviewEvent => event),
					),
		};
	}),
);
