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

export const RelationshipKind = Schema.Literals(["uses", "calls", "reads", "writes", "other"]);
export type RelationshipKind = Schema.Schema.Type<typeof RelationshipKind>;

/**
 * A pointer at exact code: a repo-relative file path and an inclusive,
 * 1-based line range. Evidence the claim is checkable against.
 */
export const Anchor = Schema.Struct({
  path: Schema.String.annotate({
    description: "Repo-relative file path, exactly as given in the task's file list.",
  }),
  lineStart: PositiveInt.annotate({
    description: "First line of the anchored range, 1-based.",
  }),
  lineEnd: PositiveInt.annotate({
    description:
      "Last line of the anchored range, inclusive; >= lineStart and <= the file's line count.",
  }),
});
export type Anchor = Schema.Schema.Type<typeof Anchor>;

/**
 * An interpretation is a claim about the code: what it guarantees, what it
 * requires, what it does, what it is for. Bound to `Anchor`s so it can be
 * revalidated against a concrete repo state later.
 */
export const Interpretation = Schema.Struct({
  id: PositiveInt.annotate({
    description:
      "Id the model assigns; ids increase across the whole session and are never reused.",
  }),
  kind: InterpretationKind.annotate({
    description:
      'The claim kind: "effect" is what executing the code does, "role" is what the code is for.',
  }),
  customKind: Schema.optional(Schema.String).annotate({
    description:
      'Required when kind is "other": a short snake_case label the model invents; must be omitted otherwise.',
  }),
  text: Schema.String.annotate({
    description: "The claim itself, in prose.",
  }),
  anchors: Schema.Array(Anchor).annotate({
    description: "Code evidence the claim is checkable against.",
  }),
});
export type Interpretation = Schema.Schema.Type<typeof Interpretation>;

export const Component = Schema.Struct({
  id: PositiveInt.annotate({
    description:
      "Id the model assigns; ids increase across the whole session and are never reused.",
  }),
  name: Schema.String.annotate({
    description: "Short name of the component; referenced by relationship from/to.",
  }),
  summary: Schema.String.annotate({
    description: "What the component is and does, in prose.",
  }),
  files: Schema.Array(Schema.String).annotate({
    description: "Repo-relative paths of the files that make up the component.",
  }),
});
export type Component = Schema.Schema.Type<typeof Component>;

export const Relationship = Schema.Struct({
  id: PositiveInt.annotate({
    description:
      "Id the model assigns; ids increase across the whole session and are never reused.",
  }),
  from: Schema.String.annotate({
    description: 'Name of the source component, present in the same answer\'s "components".',
  }),
  to: Schema.String.annotate({
    description: 'Name of the target component, present in the same answer\'s "components".',
  }),
  kind: RelationshipKind.annotate({
    description: 'How "from" relates to "to": uses, calls, reads, writes, or other.',
  }),
  customKind: Schema.optional(Schema.String).annotate({
    description:
      'Required when kind is "other": a short snake_case label the model invents; must be omitted otherwise.',
  }),
  description: Schema.String.annotate({
    description: "What the relationship is, in prose.",
  }),
});
export type Relationship = Schema.Schema.Type<typeof Relationship>;

/** The scope contains several meaningful components: divide and recurse. */
export const DivisionResult = Schema.Struct({
  kind: Schema.Literal("division").annotate({
    description: "Discriminator: the scope was divided into components.",
  }),
  components: Schema.Array(Component).annotate({
    description: "The meaningful parts the scope was divided into.",
  }),
  relationships: Schema.Array(Relationship).annotate({
    description: "How the components are strung together.",
  }),
  interpretations: Schema.Array(Interpretation).annotate({
    description: "Claims about the scope and its components.",
  }),
});
export type DivisionResult = Schema.Schema.Type<typeof DivisionResult>;

/** The scope is one cohesive unit of code: record interpretations. */
export const CohesiveResult = Schema.Struct({
  kind: Schema.Literal("cohesive").annotate({
    description: "Discriminator: the scope is one cohesive unit of code.",
  }),
  summary: Schema.String.annotate({
    description: "What the unit is and does, in prose.",
  }),
  interpretations: Schema.Array(Interpretation).annotate({
    description: "Claims about the unit.",
  }),
});
export type CohesiveResult = Schema.Schema.Type<typeof CohesiveResult>;

export const LlmResponse = Schema.Union([DivisionResult, CohesiveResult]);
export type LlmResponse = Schema.Schema.Type<typeof LlmResponse>;

export const AnalysisArtifact = Schema.Struct({
  headCommit: Schema.String.annotate({
    description: "Git commit hash the analysis was made against.",
  }),
  generatedAt: Schema.DateTimeUtcFromString.annotate({
    description: "UTC instant the artifact was generated.",
  }),
  components: Schema.Array(Component).annotate({
    description: "Every component recorded across the whole analysis session.",
  }),
  relationships: Schema.Array(Relationship).annotate({
    description: "Every relationship recorded across the whole analysis session.",
  }),
  interpretations: Schema.Array(Interpretation).annotate({
    description: "Every interpretation recorded across the whole analysis session.",
  }),
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String.annotate({
        description: "Repo-relative file path.",
      }),
      hash: Schema.String.annotate({
        description: "Git blob hash of the file at headCommit.",
      }),
      lineCount: Schema.Int.annotate({
        description: "Number of lines in the file; a plain number, never a bigint.",
      }),
    }),
  ).annotate({
    description: "Every file the analysis referenced, with the state it was analyzed at.",
  }),
});
export type AnalysisArtifact = Schema.Schema.Type<typeof AnalysisArtifact>;
