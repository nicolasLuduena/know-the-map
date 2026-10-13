import { Schema } from "effect";

/** Raised when the analysis loop hits one of its bounds. */
export class AnalysisBoundExceededError extends Schema.TaggedError<AnalysisBoundExceededError>()(
  "AnalysisBoundExceededError",
  { message: Schema.String },
) {}

/** Raised when the directory to analyze holds no files in the checkout. */
export class EmptyScopeError extends Schema.TaggedError<EmptyScopeError>()("EmptyScopeError", {
  message: Schema.String,
}) {}
