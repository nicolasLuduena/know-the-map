import { Schema } from "effect";

/** Raised when the analysis loop hits one of its bounds. */
export class AnalysisBoundExceededError extends Schema.TaggedError<AnalysisBoundExceededError>()(
  "AnalysisBoundExceededError",
  { message: Schema.String },
) {}
