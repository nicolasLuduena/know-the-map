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
