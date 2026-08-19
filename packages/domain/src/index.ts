import { createHash } from "node:crypto";
import { Schema } from "effect";

const NonEmptyString = Schema.String.pipe(Schema.minLength(1));
const LineNumber = Schema.Number.pipe(Schema.int(), Schema.nonNegative());

export const SnapshotId = NonEmptyString.pipe(Schema.brand("SnapshotId"));
export type SnapshotId = Schema.Schema.Type<typeof SnapshotId>;
export const Revision = NonEmptyString.pipe(Schema.brand("Revision"));
export type Revision = Schema.Schema.Type<typeof Revision>;
export const RepoPath = NonEmptyString.pipe(Schema.brand("RepoPath"));
export type RepoPath = Schema.Schema.Type<typeof RepoPath>;
export const HunkId = NonEmptyString.pipe(Schema.brand("HunkId"));
export type HunkId = Schema.Schema.Type<typeof HunkId>;
export const FindingId = NonEmptyString.pipe(Schema.brand("FindingId"));
export type FindingId = Schema.Schema.Type<typeof FindingId>;

export const FileStatusSchema = Schema.Literal(
	"added",
	"modified",
	"deleted",
	"renamed",
	"copied",
);
export type FileStatus = Schema.Schema.Type<typeof FileStatusSchema>;
export const FindingSeveritySchema = Schema.Literal("info", "warning", "error");
export type FindingSeverity = Schema.Schema.Type<typeof FindingSeveritySchema>;

/** Git represents an empty side of a hunk as 0..0. */
export const LineRangeSchema = Schema.Struct({
	start: LineNumber,
	end: LineNumber,
}).pipe(
	Schema.filter(
		(range) =>
			(range.start === 0 && range.end === 0) ||
			(range.start > 0 && range.end >= range.start),
		{ message: () => "line range must be 0..0 or a positive inclusive range" },
	),
);
export type LineRange = Schema.Schema.Type<typeof LineRangeSchema>;

export const DiffLineContextSchema = Schema.Struct({
	kind: Schema.Literal("context"),
	oldLineNumber: LineNumber.pipe(Schema.positive()),
	newLineNumber: LineNumber.pipe(Schema.positive()),
	content: Schema.String,
});
export const DiffLineAdditionSchema = Schema.Struct({
	kind: Schema.Literal("addition"),
	newLineNumber: LineNumber.pipe(Schema.positive()),
	content: Schema.String,
});
export const DiffLineDeletionSchema = Schema.Struct({
	kind: Schema.Literal("deletion"),
	oldLineNumber: LineNumber.pipe(Schema.positive()),
	content: Schema.String,
});
export const DiffLineSchema = Schema.Union(
	DiffLineContextSchema,
	DiffLineAdditionSchema,
	DiffLineDeletionSchema,
);
export type DiffLine = Schema.Schema.Type<typeof DiffLineSchema>;

export const HunkSchema = Schema.Struct({
	id: HunkId,
	oldRange: LineRangeSchema,
	newRange: LineRangeSchema,
	lines: Schema.Array(DiffLineSchema),
});
export type Hunk = Schema.Schema.Type<typeof HunkSchema>;

export const FileDiffSchema = Schema.Struct({
	path: RepoPath,
	previousPath: Schema.optional(RepoPath),
	status: FileStatusSchema,
	hunks: Schema.Array(HunkSchema),
});
export type FileDiff = Schema.Schema.Type<typeof FileDiffSchema>;

export const DiffSnapshotSchema = Schema.Struct({
	id: SnapshotId,
	base: Revision,
	head: Revision,
	files: Schema.Array(FileDiffSchema),
});
export type DiffSnapshot = Schema.Schema.Type<typeof DiffSnapshotSchema>;

export const HunkExplanationSchema = Schema.Struct({
	summary: Schema.String,
	intent: Schema.optional(Schema.String),
	behaviorChanges: Schema.Array(Schema.String),
	risks: Schema.Array(Schema.String),
	confidence: Schema.Number.pipe(Schema.between(0, 1)),
});
export type HunkExplanation = Schema.Schema.Type<typeof HunkExplanationSchema>;

export const ReviewFindingSchema = Schema.Struct({
	id: FindingId,
	hunkId: HunkId,
	severity: FindingSeveritySchema,
	message: Schema.String,
});
export type ReviewFinding = Schema.Schema.Type<typeof ReviewFindingSchema>;

export const makeRevision = (value: string): Revision =>
	Schema.decodeSync(Revision)(value);
export const makeRepoPath = (value: string): RepoPath =>
	Schema.decodeSync(RepoPath)(value);
const sha256 = (value: string): string =>
	createHash("sha256").update(value).digest("hex");

export const deriveHunkId = (input: {
	readonly path: string;
	readonly oldRange: LineRange;
	readonly newRange: LineRange;
	readonly lines: ReadonlyArray<DiffLine>;
}): HunkId =>
	Schema.decodeSync(HunkId)(
		sha256(
			[
				input.path,
				`${input.oldRange.start}-${input.oldRange.end}`,
				`${input.newRange.start}-${input.newRange.end}`,
				...input.lines.map((line) => `${line.kind}:${line.content}`),
			].join("\n"),
		),
	);

/** Derives identity from immutable revisions and normalized parsed content. */
export const deriveSnapshotId = (input: {
	readonly base: Revision;
	readonly head: Revision;
	readonly files: ReadonlyArray<FileDiff>;
}): SnapshotId => Schema.decodeSync(SnapshotId)(sha256(JSON.stringify(input)));

export const decodeDiffSnapshot = Schema.decodeUnknownSync(DiffSnapshotSchema);
export const encodeDiffSnapshot = Schema.encodeSync(DiffSnapshotSchema);
export const decodeHunk = Schema.decodeUnknownSync(HunkSchema);
export const encodeHunk = Schema.encodeSync(HunkSchema);
export const decodeFileDiff = Schema.decodeUnknownSync(FileDiffSchema);
export const decodeHunkExplanation = Schema.decodeUnknownSync(
	HunkExplanationSchema,
);
export const decodeReviewFinding =
	Schema.decodeUnknownSync(ReviewFindingSchema);
export const decodeDiffSnapshotEither =
	Schema.decodeUnknownEither(DiffSnapshotSchema);
