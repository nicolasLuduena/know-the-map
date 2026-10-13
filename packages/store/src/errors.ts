import { Schema } from "effect";

/** The filesystem under `KTM_HOME` could not be read or written. */
export class StoreIoError extends Schema.TaggedError<StoreIoError>()("StoreIoError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** `index.json` exists but is not a valid index: never silently an empty one. */
export class StoreIndexError extends Schema.TaggedError<StoreIndexError>()("StoreIndexError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export class ArtifactNotFoundError extends Schema.TaggedError<ArtifactNotFoundError>()(
  "ArtifactNotFoundError",
  { message: Schema.String },
) {}
