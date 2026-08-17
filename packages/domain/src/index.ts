import { createHash } from "node:crypto";
import { Schema } from "effect";

// -- IDs (Effect.Schema branded) ------------------------------------------

/** A diff's id. Made from the base..head revision pair. */
export const SnapshotId = Schema.String.pipe(Schema.brand("SnapshotId"));
export type SnapshotId = Schema.Schema.Type<typeof SnapshotId>;

/** A git revision: a branch name, tag, or commit hash. */
export const Revision = Schema.String.pipe(Schema.brand("Revision"));
export type Revision = Schema.Schema.Type<typeof Revision>;

/** A file path inside the repository (relative to the repo root). */
export const RepoPath = Schema.String.pipe(Schema.brand("RepoPath"));
export type RepoPath = Schema.Schema.Type<typeof RepoPath>;

/** A hunk's id. Derived from the hunk's content, so it stays the same across restarts. */
export const HunkId = Schema.String.pipe(Schema.brand("HunkId"));
export type HunkId = Schema.Schema.Type<typeof HunkId>;

// -- Schemas ----------------------------------------------------------------

/** How a file changed in the diff. */
export const FileStatusSchema = Schema.Literal(
	"added",
	"modified",
	"deleted",
	"renamed",
	"copied",
);
export type FileStatus = Schema.Schema.Type<typeof FileStatusSchema>;

/** What a diff line is: unchanged, added, or removed. */
export const DiffLineKindSchema = Schema.Literal(
	"context",
	"addition",
	"deletion",
);
export type DiffLineKind = Schema.Schema.Type<typeof DiffLineKindSchema>;

/** How serious a review finding is. */
export const FindingSeveritySchema = Schema.Literal("info", "warning", "error");
export type FindingSeverity = Schema.Schema.Type<typeof FindingSeveritySchema>;

/** A line range: first and last line numbers (1-based, inclusive). */
export const LineRangeSchema = Schema.Struct({
	start: Schema.Number,
	end: Schema.Number,
});
export type LineRange = Schema.Schema.Type<typeof LineRangeSchema>;

/** One line of a diff. Old/new line numbers exist only on the side the line belongs to. */
export const DiffLineSchema = Schema.Struct({
	kind: DiffLineKindSchema,
	oldLineNumber: Schema.optional(Schema.Number),
	newLineNumber: Schema.optional(Schema.Number),
	content: Schema.String,
});
export type DiffLine = Schema.Schema.Type<typeof DiffLineSchema>;

/** One contiguous part of a diff. Its id comes from the content, not its position. */
export const HunkSchema = Schema.Struct({
	id: HunkId,
	oldRange: LineRangeSchema,
	newRange: LineRangeSchema,
	lines: Schema.Array(DiffLineSchema),
});
export type Hunk = Schema.Schema.Type<typeof HunkSchema>;

/** One changed file in a diff. */
export const FileDiffSchema = Schema.Struct({
	path: RepoPath,
	status: FileStatusSchema,
	hunks: Schema.Array(HunkSchema),
});
export type FileDiff = Schema.Schema.Type<typeof FileDiffSchema>;

/** The full diff between two revisions: all changed files. */
export const DiffSnapshotSchema = Schema.Struct({
	id: SnapshotId,
	base: Revision,
	head: Revision,
	files: Schema.Array(FileDiffSchema),
});
export type DiffSnapshot = Schema.Schema.Type<typeof DiffSnapshotSchema>;

/** What an analyzer says about a hunk. */
export const HunkExplanationSchema = Schema.Struct({
	summary: Schema.String,
	// wire format stays `string | undefined`, TS type becomes Option<string>
	intent: Schema.OptionFromUndefinedOr(Schema.String),
	behaviorChanges: Schema.Array(Schema.String),
	risks: Schema.Array(Schema.String),
	confidence: Schema.Number.pipe(Schema.between(0, 1)),
});
export type HunkExplanation = Schema.Schema.Type<typeof HunkExplanationSchema>;

/** A review finding tied to a hunk. */
export const ReviewFindingSchema = Schema.Struct({
	id: Schema.String,
	hunkId: HunkId,
	severity: FindingSeveritySchema,
	message: Schema.String,
});
export type ReviewFinding = Schema.Schema.Type<typeof ReviewFindingSchema>;

// -- ID constructors ----------------------------------------------------------

/** Creates a Revision from a string. */
export const makeRevision = (value: string): Revision =>
	Schema.decodeSync(Revision)(value);

/** Creates a RepoPath from a string. */
export const makeRepoPath = (value: string): RepoPath =>
	Schema.decodeSync(RepoPath)(value);

/** Creates a SnapshotId from a base and a head revision. */
export const makeSnapshotId = (base: string, head: string): SnapshotId =>
	Schema.decodeSync(SnapshotId)(`${base}..${head}`);

/** Makes a hunk id from its content. Stable across restarts. */
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

/** Decodes an untrusted value into a DiffSnapshot. Throws if invalid. */
export const decodeDiffSnapshot = Schema.decodeUnknownSync(DiffSnapshotSchema);
/** Turns a DiffSnapshot into a plain JSON value. */
export const encodeDiffSnapshot = Schema.encodeSync(DiffSnapshotSchema);
/** Decodes an untrusted value into a Hunk. Throws if invalid. */
export const decodeHunk = Schema.decodeUnknownSync(HunkSchema);
/** Turns a Hunk into a plain JSON value. */
export const encodeHunk = Schema.encodeSync(HunkSchema);
/** Decodes an untrusted value into a FileDiff. Throws if invalid. */
export const decodeFileDiff = Schema.decodeUnknownSync(FileDiffSchema);
/** Decodes an untrusted value into a HunkExplanation. Throws if invalid. */
export const decodeHunkExplanation = Schema.decodeUnknownSync(
	HunkExplanationSchema,
);
/** Decodes an untrusted value into a ReviewFinding. Throws if invalid. */
export const decodeReviewFinding =
	Schema.decodeUnknownSync(ReviewFindingSchema);
/** Decodes an untrusted value into a DiffSnapshot. Returns a Left on invalid input. */
export const decodeDiffSnapshotEither =
	Schema.decodeUnknownEither(DiffSnapshotSchema);
