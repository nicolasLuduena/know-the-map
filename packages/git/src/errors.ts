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
    reason: Schema.Literals(["missing", "hash_mismatch", "not_a_file", "too_large", "binary"]),
  },
) {}
