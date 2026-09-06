import { AnalysisArtifactShape } from "@know-the-map/hermeneut";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

/** A request the viewer understood but could not answer. */
export class ViewerError extends Schema.TaggedError<ViewerError>()("ViewerError", {
  message: Schema.String.annotate({
    description: "What went wrong, phrased for the person using the viewer.",
  }),
}) {}

/**
 * Why a source read did not produce content, distinct enough for the pane to
 * choose its wording rather than showing one generic failure:
 *
 * - `not_in_analysis` — the path was never part of this artifact's file
 *   inventory; refusing it is the security boundary that keeps the viewer
 *   from reading arbitrary repository files on request.
 * - `stale` — the repository no longer has the exact content the artifact
 *   recorded (the blob is missing, changed, or is no longer a plain file).
 * - `binary` — the recorded content is not text.
 * - `too_large` — the recorded content is over the viewer's size cap.
 * - `unreadable` — git itself failed to answer, for a reason unrelated to
 *   the content above (e.g. the repository is unavailable).
 */
export class SourceReadError extends Schema.TaggedError<SourceReadError>()("SourceReadError", {
  message: Schema.String.annotate({
    description: "What went wrong, phrased for the person using the viewer.",
  }),
  reason: Schema.Literals([
    "not_in_analysis",
    "stale",
    "binary",
    "too_large",
    "unreadable",
  ]).annotate({
    description: "Why the source could not be shown, so the pane can render a specific message.",
  }),
}) {}

/** Repo-relative path of the file to open, as cited by the analysis. */
export const ReadSourcePayload = Schema.Struct({
  path: Schema.String.annotate({
    description: "Repo-relative path, exactly as it appears in the artifact's file inventory.",
  }),
});
export type ReadSourcePayload = Schema.Schema.Type<typeof ReadSourcePayload>;

/**
 * A file's content as it was at the analyzed commit, plus what the pane
 * needs to confirm it is showing what it thinks it is showing.
 */
export const SourceFile = Schema.Struct({
  path: Schema.String.annotate({
    description: "Repo-relative path of the file that was read.",
  }),
  content: Schema.String.annotate({
    description: "Full text content of the file at the analyzed commit.",
  }),
  hash: Schema.String.annotate({
    description: "Git blob hash of the content returned, matching the artifact's file inventory.",
  }),
});
export type SourceFile = Schema.Schema.Type<typeof SourceFile>;

/**
 * Everything the interface needs to render a saved analysis.
 *
 * The artifact travels as `AnalysisArtifactShape`, not `AnalysisArtifact`:
 * the server decoded it with the checked schema when it read the file, so
 * re-running that whole-tree walk in the browser before first paint would
 * re-prove something this process just established. `buildViewerModel`
 * defends the invariants the shape alone does not carry.
 */
export const ViewerSnapshot = Schema.Struct({
  repositoryName: Schema.String.annotate({
    description: "Name of the repository the analysis was made against.",
  }),
  artifact: AnalysisArtifactShape.annotate({
    description: "The saved analysis, already validated when the viewer started.",
  }),
});
export type ViewerSnapshot = Schema.Schema.Type<typeof ViewerSnapshot>;

/**
 * The viewer's wire contract, shared verbatim by the server and the browser
 * so neither restates the other's types.
 *
 * `getArtifact` and `readSource` are what exists today. The transport
 * carries streaming responses (`RpcSchema.Stream`), which is what later
 * slices need for live analysis progress and for asking the harness a
 * question mid-review; those arrive as additional entries here, not as a
 * different transport.
 */
export const ViewerRpc = RpcGroup.make(
  Rpc.make("getArtifact", { success: ViewerSnapshot, error: ViewerError }),
  Rpc.make("readSource", {
    payload: ReadSourcePayload,
    success: SourceFile,
    error: SourceReadError,
  }),
);
