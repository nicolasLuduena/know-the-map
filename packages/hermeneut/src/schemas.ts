import { Schema } from "effect";

export const PositiveInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)));
export type PositiveInt = Schema.Schema.Type<typeof PositiveInt>;

export const InterpretationKind = Schema.Literals([
  "invariant",
  "precondition",
  "postcondition",
  "effect",
  "role",
  "other",
]);
export type InterpretationKind = Schema.Schema.Type<typeof InterpretationKind>;

/**
 * A pointer at exact code: a repo-relative file path and an inclusive,
 * 1-based line range. Evidence the claim is checkable against.
 */
export const Anchor = Schema.Struct({
  path: Schema.String,
  lineStart: PositiveInt,
  lineEnd: PositiveInt,
});
export type Anchor = Schema.Schema.Type<typeof Anchor>;

/**
 * An interpretation is a claim about the code: what it guarantees, what it
 * requires, what it does, what it is for. Bound to `Anchor`s so it can be
 * revalidated against a concrete repo state later.
 */
export const Interpretation = Schema.Struct({
  id: PositiveInt,
  kind: InterpretationKind,
  /** Required when `kind` is "other": a short snake_case label the model invents. */
  customKind: Schema.optional(Schema.String),
  text: Schema.String,
  anchors: Schema.Array(Anchor),
});
export type Interpretation = Schema.Schema.Type<typeof Interpretation>;

export const Component = Schema.Struct({
  id: PositiveInt,
  name: Schema.String,
  summary: Schema.String,
  files: Schema.Array(Schema.String),
});
export type Component = Schema.Schema.Type<typeof Component>;

export const Relationship = Schema.Struct({
  id: PositiveInt,
  from: Schema.String,
  to: Schema.String,
  kind: Schema.String,
  description: Schema.String,
});
export type Relationship = Schema.Schema.Type<typeof Relationship>;

/** The scope contains several meaningful components: divide and recurse. */
export const DivisionResult = Schema.Struct({
  kind: Schema.Literal("division"),
  components: Schema.Array(Component),
  relationships: Schema.Array(Relationship),
  interpretations: Schema.Array(Interpretation),
});
export type DivisionResult = Schema.Schema.Type<typeof DivisionResult>;

/** The scope is one cohesive unit of code: record interpretations. */
export const CohesiveResult = Schema.Struct({
  kind: Schema.Literal("cohesive"),
  summary: Schema.String,
  interpretations: Schema.Array(Interpretation),
});
export type CohesiveResult = Schema.Schema.Type<typeof CohesiveResult>;

export const LlmResponse = Schema.Union([DivisionResult, CohesiveResult]);
export type LlmResponse = Schema.Schema.Type<typeof LlmResponse>;

export const AnalysisArtifact = Schema.Struct({
  headCommit: Schema.String,
  generatedAt: Schema.String,
  components: Schema.Array(Component),
  relationships: Schema.Array(Relationship),
  interpretations: Schema.Array(Interpretation),
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      hash: Schema.String,
      lineCount: Schema.Int,
    }),
  ),
});
export type AnalysisArtifact = Schema.Schema.Type<typeof AnalysisArtifact>;
