import type { DiffSnapshot, HunkExplanation, HunkId } from "@bleentr/domain";
import { ReviewFindingSchema } from "@bleentr/domain";
import type { ReviewEngine } from "@bleentr/engine";
import { EngineError, ReviewEngineService } from "@bleentr/engine";
import { Effect, Schema, Stream } from "effect";

// -- Error protocol -------------------------------------------------------------

export class DiffError extends Schema.TaggedError<DiffError>()("DiffError", {
	message: Schema.String,
}) {}

export class AnalysisError extends Schema.TaggedError<AnalysisError>()(
	"AnalysisError",
	{ message: Schema.String },
) {}

export class ReviewError extends Schema.TaggedError<ReviewError>()(
	"ReviewError",
	{ message: Schema.String },
) {}

// -- Inputs ---------------------------------------------------------------------

export interface ResolveDiffInput {
	readonly base: string;
	readonly head: string;
	readonly path?: string;
}

export interface Message {
	readonly role: "user" | "assistant";
	readonly content: string;
}

export interface ExplainHunkInput {
	readonly snapshot: DiffSnapshot;
	readonly hunkId: HunkId;
	readonly contextPolicy?: string;
	readonly analyzer?: string;
}

export interface AskAboutHunkInput {
	readonly snapshot: DiffSnapshot;
	readonly hunkId: HunkId;
	readonly question: string;
	readonly previousMessages?: ReadonlyArray<Message>;
	readonly contextPolicy?: string;
	readonly analyzer?: string;
}

export interface ReviewDiffInput {
	readonly snapshot: DiffSnapshot;
	readonly analyzer?: string;
}

// -- Events ---------------------------------------------------------------------

export const AnswerEventSchema = Schema.Union(
	Schema.Struct({ _tag: Schema.Literal("Text"), text: Schema.String }),
	Schema.Struct({ _tag: Schema.Literal("Done"), answer: Schema.String }),
);
export type AnswerEvent = Schema.Schema.Type<typeof AnswerEventSchema>;

export const ReviewEventSchema = Schema.Union(
	Schema.Struct({ _tag: Schema.Literal("Text"), text: Schema.String }),
	Schema.Struct({
		_tag: Schema.Literal("Finding"),
		finding: ReviewFindingSchema,
	}),
	Schema.Struct({ _tag: Schema.Literal("Done") }),
);
export type ReviewEvent = Schema.Schema.Type<typeof ReviewEventSchema>;

// -- ReviewApi ---------------------------------------------------------------------

export interface ReviewApi {
	readonly resolveDiff: (
		input: ResolveDiffInput,
	) => Effect.Effect<DiffSnapshot, DiffError>;

	readonly explainHunk: (
		input: ExplainHunkInput,
	) => Effect.Effect<HunkExplanation, AnalysisError>;

	readonly askAboutHunk: (
		input: AskAboutHunkInput,
	) => Stream.Stream<AnswerEvent, AnalysisError>;

	readonly reviewDiff: (
		input: ReviewDiffInput,
	) => Stream.Stream<ReviewEvent, ReviewError>;
}

// -- ReviewApiService ---------------------------------------------------------------

export class ReviewApiService extends Effect.Service<ReviewApiService>()(
	"wth/ReviewApiService",
	{
		effect: Effect.gen(function* () {
			const engine: ReviewEngine = yield* ReviewEngineService;
			return {
				resolveDiff: (input: ResolveDiffInput) =>
					engine
						.resolveDiff(input)
						.pipe(
							Effect.catchTag(EngineError._tag, (error) =>
								Effect.fail(new DiffError({ message: error.message })),
							),
						),
				explainHunk: (input: ExplainHunkInput) =>
					engine
						.explainHunk(input)
						.pipe(
							Effect.catchTag(EngineError._tag, (error) =>
								Effect.fail(new AnalysisError({ message: error.message })),
							),
						),
				askAboutHunk: (input: AskAboutHunkInput) =>
					engine.askAboutHunk(input).pipe(
						Stream.mapError(
							(error) => new AnalysisError({ message: error.message }),
						),
						Stream.map((event): AnswerEvent => {
							if (event._tag === "Text")
								return { _tag: "Text", text: event.text };
							if (event._tag === "ToolCall")
								return {
									_tag: "Text",
									text: `[tool call: ${event.name}]`,
								};
							return { _tag: "Done", answer: event.output };
						}),
					),
				reviewDiff: (input: ReviewDiffInput) =>
					engine
						.reviewDiff(input)
						.pipe(
							Stream.mapError(
								(error) => new ReviewError({ message: error.message }),
							),
						) as Stream.Stream<ReviewEvent, ReviewError>,
			} satisfies ReviewApi;
		}),
		dependencies: [ReviewEngineService.Default],
	},
) {}
