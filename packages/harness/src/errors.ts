import { Schema } from "effect";

/**
 * Raised wherever a design has been typed but not implemented yet. Every
 * skeleton in the monorepo fails loudly with this instead of pretending to
 * work.
 */
export class NotImplementedError extends Schema.TaggedError<NotImplementedError>()(
  "NotImplementedError",
  { message: Schema.String },
) {}

export class HostFailureError extends Schema.TaggedError<HostFailureError>()("HostFailureError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class MissingApiKeyError extends Schema.TaggedError<MissingApiKeyError>()(
  "MissingApiKeyError",
  { message: Schema.String },
) {}

export class NoSubmissionError extends Schema.TaggedError<NoSubmissionError>()(
  "NoSubmissionError",
  { message: Schema.String },
) {}

export class InvalidResultError extends Schema.TaggedError<InvalidResultError>()(
  "InvalidResultError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
