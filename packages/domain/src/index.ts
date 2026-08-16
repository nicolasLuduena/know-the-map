import { createHash } from "node:crypto";
import { Schema } from "effect";

// -- IDs (Effect.Schema branded) ------------------------------------------

export const SnapshotId = Schema.String.pipe(Schema.brand("SnapshotId"));
export type SnapshotId = Schema.Schema.Type<typeof SnapshotId>;

export const Revision = Schema.String.pipe(Schema.brand("Revision"));
export type Revision = Schema.Schema.Type<typeof Revision>;

export const RepoPath = Schema.String.pipe(Schema.brand("RepoPath"));
export type RepoPath = Schema.Schema.Type<typeof RepoPath>;

export const HunkId = Schema.String.pipe(Schema.brand("HunkId"));
export type HunkId = Schema.Schema.Type<typeof HunkId>;

// -- Schemas ----------------------------------------------------------------

export const FileStatusSchema = Schema.Literal(
	"added",
	"modified",
	"deleted",
	"renamed",
	"copied",
);
export type FileStatus = Schema.Schema.Type<typeof FileStatusSchema>;

export const DiffLineKindSchema = Schema.Literal(
	"context",
	"addition",
	"deletion",
);
export type DiffLineKind = Schema.Schema.Type<typeof DiffLineKindSchema>;

export const FindingSeveritySchema = Schema.Literal("info", "warning", "error");
export type FindingSeverity = Schema.Schema.Type<typeof FindingSeveritySchema>;

export const LineRangeSchema = Schema.Struct({
	start: Schema.Number,
	end: Schema.Number,
});
export type LineRange = Schema.Schema.Type<typeof LineRangeSchema>;

export const DiffLineSchema = Schema.Struct({
	kind: DiffLineKindSchema,
	oldLineNumber: Schema.optional(Schema.Number),
	newLineNumber: Schema.optional(Schema.Number),
	content: Schema.String,
});
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
	// wire format stays `string | undefined`, TS type becomes Option<string>
	intent: Schema.OptionFromUndefinedOr(Schema.String),
	behaviorChanges: Schema.Array(Schema.String),
	risks: Schema.Array(Schema.String),
	confidence: Schema.Number.pipe(Schema.between(0, 1)),
});
export type HunkExplanation = Schema.Schema.Type<typeof HunkExplanationSchema>;

export const ReviewFindingSchema = Schema.Struct({
	id: Schema.String,
	hunkId: HunkId,
	severity: FindingSeveritySchema,
	message: Schema.String,
});
export type ReviewFinding = Schema.Schema.Type<typeof ReviewFindingSchema>;

// -- ID constructors ----------------------------------------------------------

export const makeRevision = (value: string): Revision =>
	Schema.decodeSync(Revision)(value);

export const makeRepoPath = (value: string): RepoPath =>
	Schema.decodeSync(RepoPath)(value);

export const makeSnapshotId = (base: string, head: string): SnapshotId =>
	Schema.decodeSync(SnapshotId)(`${base}..${head}`);

// Hunk IDs derive from normalized content — stable across UI restarts.
export const deriveHunkId = (input: {
	readonly path: string;
	readonly oldRange: LineRange;
	readonly newRange: LineRange;
	readonly lines: ReadonlyArray<DiffLine>;
}): HunkId => {
	const normalized = [
		input.path,
		`${input.oldRange.start}-${input.oldRange.end}`,
		`${input.newRange.start}-${input.newRange.end}`,
		...input.lines.map((line) => `${line.kind}:${line.content}`),
	].join("\n");
	return Schema.decodeSync(HunkId)(
		createHash("sha256").update(normalized).digest("hex"),
	);
};

// -- Codec helpers ------------------------------------------------------------

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
