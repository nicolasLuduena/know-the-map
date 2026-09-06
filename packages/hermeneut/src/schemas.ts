import { Schema } from "effect";

export const PositiveInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)));
export type PositiveInt = Schema.Schema.Type<typeof PositiveInt>;

/**
 * A label the model invents for claims that don't fit the known kinds.
 * snake_case: these are machine-readable wire labels (grep-able,
 * case-stable), not prose.
 */
const CustomKind = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/, {
      description: 'a short snake_case label, e.g. "type_narrowing"',
    }),
  ),
);

export const InterpretationKind = Schema.Union([
  Schema.Literal("invariant").annotate({
    description: "A property the code always maintains.",
  }),
  Schema.Literal("precondition").annotate({
    description: "What callers must guarantee before the code runs.",
  }),
  Schema.Literal("postcondition").annotate({
    description: "What the code guarantees once it finishes.",
  }),
  Schema.Literal("effect").annotate({
    description: "What executing the code does.",
  }),
  Schema.Literal("role").annotate({
    description: "What the code is for.",
  }),
]);
export type InterpretationKind = Schema.Schema.Type<typeof InterpretationKind>;

export const RelationshipKind = Schema.Union([
  Schema.Literal("uses").annotate({
    description: "The source consumes the target's output or exports.",
  }),
  Schema.Literal("calls").annotate({
    description: "The source invokes the target at runtime.",
  }),
  Schema.Literal("reads").annotate({
    description: "The source observes the target's state.",
  }),
  Schema.Literal("writes").annotate({
    description: "The source changes the target's state.",
  }),
]);
export type RelationshipKind = Schema.Schema.Type<typeof RelationshipKind>;

/**
 * A pointer at exact code: a repo-relative file path and an inclusive,
 * 1-based line range. Evidence the claim is checkable against.
 */
const AnchorFields = {
  path: Schema.String.annotate({
    description: "Repo-relative file path, exactly as given in the task's file list.",
  }),
  lineStart: PositiveInt.annotate({
    description: "First line of the anchored range, 1-based.",
  }),
  lineEnd: PositiveInt.annotate({
    description: "Last line of the anchored range, inclusive.",
  }),
};

export const Anchor = Schema.Struct(AnchorFields).check(
  Schema.makeFilter((anchor) =>
    anchor.lineStart > anchor.lineEnd
      ? {
          path: ["lineEnd"],
          issue: `lineEnd ${anchor.lineEnd} is before lineStart ${anchor.lineStart}`,
        }
      : undefined,
  ),
);
export type Anchor = Schema.Schema.Type<typeof Anchor>;

const idField = PositiveInt.annotate({
  description: "Id the model assigns; unique within this answer.",
});

const interpretationBase = {
  id: idField,
  text: Schema.String.annotate({
    description: "The claim itself, in prose. One or two sentences.",
  }),
  anchors: Schema.Array(Anchor)
    .check(
      Schema.makeFilter((anchors) =>
        anchors.length === 0
          ? { path: [], issue: "an interpretation must cite at least one code anchor" }
          : undefined,
      ),
    )
    .annotate({
      description: "Code evidence the claim is checkable against.",
    }),
};

/**
 * An interpretation is a claim about the code: what it guarantees, what it
 * requires, what it does, what it is for. Bound to `Anchor`s so it can be
 * revalidated against a concrete repo state later. The two variants encode
 * the customKind rule in the type itself: `kind: "other"` requires
 * `customKind`, any other kind forbids it.
 */
export const Interpretation = Schema.Union([
  Schema.Struct({
    ...interpretationBase,
    kind: InterpretationKind.annotate({ description: "The claim kind." }),
    customKind: Schema.optionalKey(Schema.Never),
  }),
  Schema.Struct({
    ...interpretationBase,
    kind: Schema.Literal("other").annotate({
      description: "None of the known kinds; requires customKind.",
    }),
    customKind: CustomKind.annotate({
      description: "A short snake_case label the model invents.",
    }),
  }),
]);
export type Interpretation = Schema.Schema.Type<typeof Interpretation>;

export const Component = Schema.Struct({
  id: idField,
  name: Schema.String.annotate({
    description: "Short name of the component; relationship from/to refer to it.",
  }),
  summary: Schema.String.annotate({
    description: "What the component is and does, in prose. One or two sentences.",
  }),
  files: Schema.Array(Schema.String)
    .check(
      Schema.makeFilter((files) =>
        files.length === 0
          ? { path: [], issue: "a component must list at least one file" }
          : undefined,
      ),
    )
    .annotate({
      description: "Repo-relative paths of the files that make up the component.",
    }),
});
export type Component = Schema.Schema.Type<typeof Component>;

const relationshipBase = {
  id: idField,
  from: Schema.String.annotate({
    description: 'Name of the source component, present in the same answer\'s "components".',
  }),
  to: Schema.String.annotate({
    description: 'Name of the target component, present in the same answer\'s "components".',
  }),
  description: Schema.String.annotate({
    description: "What the relationship is, in prose. One or two sentences.",
  }),
};

export const Relationship = Schema.Union([
  Schema.Struct({
    ...relationshipBase,
    kind: RelationshipKind.annotate({ description: "How the source relates to the target." }),
    customKind: Schema.optionalKey(Schema.Never),
  }),
  Schema.Struct({
    ...relationshipBase,
    kind: Schema.Literal("other").annotate({
      description: "None of the known kinds; requires customKind.",
    }),
    customKind: CustomKind.annotate({
      description: "A short snake_case label the model invents.",
    }),
  }),
]);
export type Relationship = Schema.Schema.Type<typeof Relationship>;

interface IdClaim {
  readonly id: number;
}

interface ResponseClaims {
  readonly components?: ReadonlyArray<IdClaim>;
  readonly relationships?: ReadonlyArray<IdClaim>;
  readonly interpretations: ReadonlyArray<IdClaim>;
}

/**
 * Ids are the model's own handles for clarification ("fix claim 7"), so
 * they only have to be consistent within one answer — cross-answer reuse
 * is fine and keeps the model from chasing a global counter.
 */
const checkUniqueIds = (claims: ResponseClaims): Schema.FilterIssue | undefined => {
  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const group of [claims.components, claims.relationships, claims.interpretations]) {
    for (const claim of group ?? []) {
      if (seen.has(claim.id)) {
        duplicates.add(claim.id);
      }
      seen.add(claim.id);
    }
  }
  return duplicates.size === 0
    ? undefined
    : {
        path: [],
        issue: `claim id(s) ${[...duplicates].join(", ")} are not unique within this answer`,
      };
};

const DivisionBase = Schema.Struct({
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

/** The scope contains several meaningful components: divide and recurse. */
export const DivisionResult = DivisionBase.check(
  Schema.makeFilter((division: Schema.Schema.Type<typeof DivisionBase>) => {
    const issues: Array<Schema.FilterIssue> = [];
    if (division.components.length === 0) {
      issues.push({ path: ["components"], issue: "a division must name at least one component" });
    }
    // TODO(analysis): a division is assumed complete — nothing here bounds
    // how many components one answer should hold, and huge scopes may
    // overwhelm the model. Revisit with a pathological codebase.
    const names = new Set<string>();
    division.components.forEach((component, index) => {
      if (names.has(component.name)) {
        issues.push({
          path: ["components", index, "name"],
          issue: `duplicate component name "${component.name}"; relationship endpoints refer by name`,
        });
      }
      names.add(component.name);
    });
    division.relationships.forEach((relationship, index) => {
      for (const endpoint of [relationship.from, relationship.to]) {
        if (!names.has(endpoint)) {
          issues.push({
            path: ["relationships", index, endpoint === relationship.from ? "from" : "to"],
            issue: `endpoint "${endpoint}" is not a component in this answer`,
          });
        }
      }
    });
    const ids = checkUniqueIds(division);
    if (ids !== undefined) {
      issues.push(ids);
    }
    return issues;
  }),
);
export type DivisionResult = Schema.Schema.Type<typeof DivisionResult>;

const ModuleBase = Schema.Struct({
  kind: Schema.Literal("module").annotate({
    description: "Discriminator: the scope is one module of code.",
  }),
  summary: Schema.String.annotate({
    description: "What the unit is and does, in prose. One or two sentences.",
  }),
  interpretations: Schema.Array(Interpretation).annotate({
    description: "Claims about the unit.",
  }),
});

/** The scope is one module of code: record interpretations. */
export const ModuleResult = ModuleBase.check(
  Schema.makeFilter((result: Schema.Schema.Type<typeof ModuleBase>) => checkUniqueIds(result)),
);
export type ModuleResult = Schema.Schema.Type<typeof ModuleResult>;

export const LlmResponse = Schema.Union([DivisionResult, ModuleResult]);
export type LlmResponse = Schema.Schema.Type<typeof LlmResponse>;

/** The state a file was analyzed at. */
export const FileStatus = Schema.Struct({
  path: Schema.String.annotate({
    description: "Repo-relative file path.",
  }),
  hash: Schema.String.annotate({
    description: "Git blob hash of the file at headCommit.",
  }),
  lineCount: Schema.Int.annotate({
    description: "Number of lines in the file; lets anchors be rechecked without git access.",
  }),
});
export type FileStatus = Schema.Schema.Type<typeof FileStatus>;

export const AnalysisScope = Schema.Struct({
  id: PositiveInt.annotate({ description: "Run-local scope id." }),
  parentScopeId: Schema.NullOr(PositiveInt).annotate({
    description: "Parent scope id, or null for the repository root.",
  }),
  originatingComponentId: Schema.NullOr(PositiveInt).annotate({
    description: "Component in the parent division that created this scope, or null at root.",
  }),
  inputPaths: Schema.Array(Schema.String).annotate({
    description: "Repo-relative paths submitted for this scope.",
  }),
  result: LlmResponse.annotate({ description: "Validated model response for this scope." }),
});
export type AnalysisScope = Schema.Schema.Type<typeof AnalysisScope>;

const AnalysisArtifactBase = Schema.Struct({
  version: Schema.Literal(1).annotate({ description: "Analysis artifact format version." }),
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
  files: Schema.Array(FileStatus).annotate({
    description: "Every file the analysis referenced, with the state it was analyzed at.",
  }),
  scopes: Schema.Array(AnalysisScope).annotate({
    description: "Exploration scopes in traversal order, preserving their hierarchy and responses.",
  }),
});
export const AnalysisArtifact = AnalysisArtifactBase.check(
  Schema.makeFilter((artifact: Schema.Schema.Type<typeof AnalysisArtifactBase>) => {
    const issues: Array<Schema.FilterIssue> = [];
    const scopes = new Map<number, AnalysisScope>();
    const inventory = new Set(artifact.files.map((file) => file.path));
    if (inventory.size !== artifact.files.length)
      issues.push({ path: ["files"], issue: "file inventory contains duplicate paths" });
    const childOwners = new Set<string>();
    for (const [index, scope] of artifact.scopes.entries()) {
      if (scopes.has(scope.id))
        issues.push({ path: ["scopes", index, "id"], issue: `duplicate scope id ${scope.id}` });
      scopes.set(scope.id, scope);
      for (const path of scope.inputPaths)
        if (!inventory.has(path))
          issues.push({
            path: ["scopes", index, "inputPaths"],
            issue: `path "${path}" is missing from the file inventory`,
          });
      if (scope.result.kind === "division")
        for (const component of scope.result.components)
          for (const path of component.files)
            if (!inventory.has(path))
              issues.push({
                path: ["scopes", index, "result", "components"],
                issue: `path "${path}" is missing from the file inventory`,
              });
      for (const interpretation of scope.result.interpretations)
        for (const anchor of interpretation.anchors)
          if (!inventory.has(anchor.path))
            issues.push({
              path: ["scopes", index, "result", "interpretations"],
              issue: `anchor path "${anchor.path}" is missing from the file inventory`,
            });
    }
    const roots = artifact.scopes.filter((scope) => scope.parentScopeId === null);
    if (roots.length !== 1)
      issues.push({ path: ["scopes"], issue: "artifact must contain exactly one root scope" });
    for (const [index, scope] of artifact.scopes.entries()) {
      if (scope.parentScopeId === null) {
        if (scope.originatingComponentId !== null)
          issues.push({
            path: ["scopes", index, "originatingComponentId"],
            issue: "root scope cannot originate from a component",
          });
        continue;
      }
      const parent = scopes.get(scope.parentScopeId);
      const component =
        parent?.result.kind === "division"
          ? parent.result.components.find(
              (candidate) => candidate.id === scope.originatingComponentId,
            )
          : undefined;
      if (component === undefined)
        issues.push({
          path: ["scopes", index],
          issue: "scope references a missing parent component",
        });
      else {
        const owner = `${parent?.id}:${component.id}`;
        if (childOwners.has(owner))
          issues.push({
            path: ["scopes", index],
            issue: "parent component has multiple child scopes",
          });
        childOwners.add(owner);
        if (component.files.join("\0") !== scope.inputPaths.join("\0"))
          issues.push({
            path: ["scopes", index, "inputPaths"],
            issue: "scope input paths differ from its parent component",
          });
      }
    }
    const scopedComponents = artifact.scopes.flatMap((scope) =>
      scope.result.kind === "division" ? scope.result.components : [],
    );
    const scopedRelationships = artifact.scopes.flatMap((scope) =>
      scope.result.kind === "division" ? scope.result.relationships : [],
    );
    const scopedInterpretations = artifact.scopes.flatMap((scope) => scope.result.interpretations);
    for (const scope of artifact.scopes)
      if (scope.result.kind === "division")
        for (const component of scope.result.components)
          if (!childOwners.has(`${scope.id}:${component.id}`))
            issues.push({
              path: ["scopes"],
              issue: `component ${scope.id}:${component.id} has no analyzed child scope`,
            });
    const root = roots[0];
    if (root !== undefined) {
      const reachable = new Set<number>();
      const visit = (scope: AnalysisScope): void => {
        if (reachable.has(scope.id)) return;
        reachable.add(scope.id);
        for (const child of artifact.scopes) if (child.parentScopeId === scope.id) visit(child);
      };
      visit(root);
      if (reachable.size !== artifact.scopes.length)
        issues.push({
          path: ["scopes"],
          issue: "scope hierarchy contains a cycle or unreachable scope",
        });
    }
    if (JSON.stringify(scopedComponents) !== JSON.stringify(artifact.components))
      issues.push({
        path: ["components"],
        issue: "flattened components do not match scope responses",
      });
    if (JSON.stringify(scopedRelationships) !== JSON.stringify(artifact.relationships))
      issues.push({
        path: ["relationships"],
        issue: "flattened relationships do not match scope responses",
      });
    if (JSON.stringify(scopedInterpretations) !== JSON.stringify(artifact.interpretations))
      issues.push({
        path: ["interpretations"],
        issue: "flattened interpretations do not match scope responses",
      });
    return issues;
  }),
);
export type AnalysisArtifact = Schema.Schema.Type<typeof AnalysisArtifact>;
