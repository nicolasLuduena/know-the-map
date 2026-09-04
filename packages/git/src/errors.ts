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
