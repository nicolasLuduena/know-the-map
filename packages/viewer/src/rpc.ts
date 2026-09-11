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
 * Only `getArtifact` exists today. The transport carries streaming
 * responses (`RpcSchema.Stream`), which is what later slices need for live
 * analysis progress and for asking the harness a question mid-review; those
 * arrive as additional entries here, not as a different transport.
 */
export const ViewerRpc = RpcGroup.make(
  Rpc.make("getArtifact", { success: ViewerSnapshot, error: ViewerError }),
);
