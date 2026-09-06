import { Schema } from "effect";

export class RepoNotFoundError extends Schema.TaggedError<RepoNotFoundError>()(
  "RepoNotFoundError",
  { message: Schema.String },
) {}

export class DirtyTreeError extends Schema.TaggedError<DirtyTreeError>()("DirtyTreeError", {
  message: Schema.String,
  entries: Schema.Array(Schema.String),
}) {}

export class GitCommandError extends Schema.TaggedError<GitCommandError>()("GitCommandError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export class SnapshotFileError extends Schema.TaggedError<SnapshotFileError>()(
  "SnapshotFileError",
  {
    message: Schema.String,
    reason: Schema.Union([
      Schema.Literal("missing"),
      Schema.Literal("binary"),
      Schema.Literal("too_large"),
      Schema.Literal("hash_mismatch"),
    ]),
  },
) {}
