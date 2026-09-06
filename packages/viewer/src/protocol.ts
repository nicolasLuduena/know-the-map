import { AnalysisArtifact, Anchor } from "@know-the-map/hermeneut";
import { Schema } from "effect";

export const ViewerResponse = Schema.Struct({
  repositoryName: Schema.String.annotate({ description: "Name of the local repository." }),
  artifact: AnalysisArtifact.annotate({ description: "Validated saved analysis." }),
});
export type ViewerResponse = typeof ViewerResponse.Type;

export const SourceSelection = Schema.Struct({
  path: Schema.String.annotate({ description: "File from the analyzed inventory." }),
  anchor: Schema.optionalKey(Anchor).annotate({
    description: "Optional cited range to highlight.",
  }),
});
export type SourceSelection = typeof SourceSelection.Type;

export const SourceResponse = Schema.Struct({
  path: Schema.String.annotate({ description: "Repo-relative source path." }),
  commit: Schema.String.annotate({ description: "Analyzed Git commit." }),
  content: Schema.String.annotate({ description: "Source at the analyzed commit." }),
});
export type SourceResponse = typeof SourceResponse.Type;

export const ViewerErrorResponse = Schema.Struct({
  message: Schema.String.annotate({ description: "Actionable failure explanation." }),
});

export const SourceQuery = Schema.Union([
  Schema.Struct({
    path: Schema.String.annotate({ description: "Inventory path to open." }),
    lineStart: Schema.optionalKey(Schema.Never),
    lineEnd: Schema.optionalKey(Schema.Never),
  }),
  Schema.Struct({
    path: Schema.String.annotate({ description: "Inventory path to open." }),
    lineStart: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/)).annotate({
      description: "First cited line, 1-based.",
    }),
    lineEnd: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/)).annotate({
      description: "Last cited line, inclusive.",
    }),
  }),
]);
