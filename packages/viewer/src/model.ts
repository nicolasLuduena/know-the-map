import type {
  AnalysisArtifact,
  AnalysisScope,
  Component,
  GapReason,
} from "@know-the-map/hermeneut";
import { componentKey } from "@know-the-map/hermeneut";

/**
 * Why a leaf node never opened into a division: it was analyzed and found to
 * be one indivisible unit ("explored"), or a run bound stopped it from ever
 * being looked at ("gap"). A node carrying `null` here is not a leaf at all
 * — it opened a division and has `children` instead. Surfacing this on the
 * node saves every caller from re-deriving it by switching on
 * `childScope.result.kind`.
 */
export type LeafStatus =
  | { readonly kind: "explored" }
  | { readonly kind: "gap"; readonly reason: GapReason; readonly message: string };

/**
 * One component, rebuilt from the scope that named it and the scope it
 * opened. Addressed by the composite `(parentScopeId, componentId)` key from
 * `componentKey` rather than the model-local component id alone, since that
 * id is only unique within the single answer that assigned it.
 */
export interface ComponentNode {
  /** Composite identity: `componentKey(scope.id, component.id)`. */
  readonly key: string;
  /** The component as the model described it. */
  readonly component: Component;
  /** The division scope that named this component. */
  readonly scope: AnalysisScope;
  /** The scope this component opened. */
  readonly childScope: AnalysisScope;
  /** The parent node's key, or `null` for a component named by the root scope. */
  readonly parentKey: string | null;
  /** Components `childScope` was in turn divided into; empty for a leaf. */
  readonly children: ReadonlyArray<ComponentNode>;
  /** Set for a leaf (see `LeafStatus`); `null` when `children` is populated. */
  readonly leaf: LeafStatus | null;
}

/**
 * The component tree rebuilt from a saved analysis, indexed for O(1) lookup
 * by composite key.
 */
export interface ViewerModel {
  readonly artifact: AnalysisArtifact;
  readonly rootScope: AnalysisScope;
  /** Components named directly by the root scope; empty if the root is a leaf. */
  readonly roots: ReadonlyArray<ComponentNode>;
  readonly nodesByKey: ReadonlyMap<string, ComponentNode>;
}

/**
 * Finds the artifact's single root scope. `AnalysisArtifact`'s own schema
 * checks already guarantee exactly one exists, but a later PR decodes the
 * wire payload with the unchecked `AnalysisArtifactShape`, which does not —
 * this becomes the real enforcement point then, so the check stays here even
 * though it is currently redundant.
 */
const findRootScope = (artifact: AnalysisArtifact): AnalysisScope => {
  const root = artifact.scopes.find((scope) => scope.parentScopeId === null);
  if (root === undefined) {
    throw new Error("analysis artifact has no root scope");
  }
  return root;
};

/**
 * Maps every component to the scope it opened, by composite key. Mirrors the
 * bookkeeping `AnalysisArtifact`'s schema does internally
 * (`checkArtifactIntegrity`), re-verified here for the same reason as
 * `findRootScope`: this is the enforcement point once callers can hand in
 * data that only passed the unchecked shape.
 */
const indexChildScopes = (
  artifact: AnalysisArtifact,
  scopesById: ReadonlyMap<number, AnalysisScope>,
): ReadonlyMap<string, AnalysisScope> => {
  const childScopeByOwner = new Map<string, AnalysisScope>();
  for (const scope of artifact.scopes) {
    if (scope.parentScopeId === null) continue;
    const parent = scopesById.get(scope.parentScopeId);
    if (parent === undefined) {
      throw new Error(`scope ${scope.id} has parent ${scope.parentScopeId}, which does not exist`);
    }
    if (parent.result.kind !== "division") {
      throw new Error(`scope ${scope.id} claims parent ${parent.id}, which is not a division`);
    }
    const component = parent.result.components.find((c) => c.id === scope.originatingComponentId);
    if (component === undefined) {
      throw new Error(
        `scope ${scope.id} claims component ${scope.originatingComponentId} of scope ${parent.id}, which does not exist`,
      );
    }
    const owner = componentKey(parent.id, component.id);
    if (childScopeByOwner.has(owner)) {
      throw new Error(`component ${owner} has more than one child scope`);
    }
    childScopeByOwner.set(owner, scope);
  }
  return childScopeByOwner;
};

const leafStatusOf = (childScope: AnalysisScope): LeafStatus | null => {
  if (childScope.result.kind === "division") return null;
  if (childScope.result.kind === "gap") {
    return { kind: "gap", reason: childScope.result.reason, message: childScope.result.message };
  }
  return { kind: "explored" };
};

/**
 * Rebuilds the component tree an `AnalysisArtifact`'s scopes encode. Every
 * component a division names opens exactly one child scope; walking that
 * link recursively from the root turns the flat `scopes` array into a tree a
 * UI can navigate.
 */
export const buildViewerModel = (artifact: AnalysisArtifact): ViewerModel => {
  const rootScope = findRootScope(artifact);
  const scopesById = new Map(artifact.scopes.map((scope) => [scope.id, scope]));
  const childScopeByOwner = indexChildScopes(artifact, scopesById);
  const nodesByKey = new Map<string, ComponentNode>();

  // `ancestry` guards against a cycle in the scope hierarchy: a scope
  // revisited within its own lineage would otherwise recurse forever.
  const buildChildren = (
    scope: AnalysisScope,
    parentKey: string | null,
    ancestry: ReadonlySet<number>,
  ): ReadonlyArray<ComponentNode> => {
    if (scope.result.kind !== "division") return [];
    return scope.result.components.map((component) => {
      const key = componentKey(scope.id, component.id);
      const childScope = childScopeByOwner.get(key);
      if (childScope === undefined) {
        throw new Error(`component ${key} has no child scope`);
      }
      if (ancestry.has(childScope.id)) {
        throw new Error(`scope hierarchy cycles back to scope ${childScope.id}`);
      }
      const nextAncestry = new Set(ancestry).add(childScope.id);
      const node: ComponentNode = {
        key,
        component,
        scope,
        childScope,
        parentKey,
        children: buildChildren(childScope, key, nextAncestry),
        leaf: leafStatusOf(childScope),
      };
      nodesByKey.set(key, node);
      return node;
    });
  };

  const roots = buildChildren(rootScope, null, new Set([rootScope.id]));
  return { artifact, rootScope, roots, nodesByKey };
};

/**
 * Node keys to show for a search string: a component matches by name or by
 * any of its file paths, case-insensitively. Every ancestor of a match is
 * kept visible too, or a tree UI could never reach the match by expanding
 * downward from a root. An empty or whitespace-only query matches everything.
 */
export const matchingNodes = (model: ViewerModel, query: string): ReadonlySet<string> => {
  const needle = query.trim().toLowerCase();
  const visible = new Set<string>();
  if (needle === "") {
    for (const key of model.nodesByKey.keys()) visible.add(key);
    return visible;
  }

  const revealAncestry = (node: ComponentNode): void => {
    let current: ComponentNode | undefined = node;
    while (current !== undefined && !visible.has(current.key)) {
      visible.add(current.key);
      current = current.parentKey === null ? undefined : model.nodesByKey.get(current.parentKey);
    }
  };

  for (const node of model.nodesByKey.values()) {
    const nameMatches = node.component.name.toLowerCase().includes(needle);
    const fileMatches = node.component.files.some((file) => file.toLowerCase().includes(needle));
    if (nameMatches || fileMatches) {
      revealAncestry(node);
    }
  }
  return visible;
};

/**
 * How much of the submitted inventory was actually explored: a file counts
 * as explored when it appears in the `inputPaths` of a scope whose result is
 * a `module` — a leaf someone actually looked at, as opposed to a scope that
 * was merely divided further or was never explored at all (a `gap`). The
 * denominator is the root scope's `inputPaths`, the full inventory the run
 * was given.
 */
export interface CoverageSummary {
  /** Size of the root scope's `inputPaths`, deduplicated. */
  readonly totalFiles: number;
  /** How many of those files appear in some `module` scope's `inputPaths`. */
  readonly exploredFiles: number;
  /** `exploredFiles / totalFiles`; `1` when `totalFiles` is `0` (nothing to explore). */
  readonly fraction: number;
  /** Number of scopes a run bound stopped from ever being explored. */
  readonly gapScopeCount: number;
}

export const coverage = (artifact: AnalysisArtifact): CoverageSummary => {
  const rootScope = findRootScope(artifact);
  const totalPaths = new Set(rootScope.inputPaths);

  const exploredPaths = new Set<string>();
  let gapScopeCount = 0;
  for (const scope of artifact.scopes) {
    if (scope.result.kind === "gap") {
      gapScopeCount += 1;
      continue;
    }
    // A single-scope artifact (the whole repo analyzed as one module) makes
    // the root scope itself a "module" scope: it is included in this loop
    // like any other, so its inputPaths land in exploredPaths and match
    // totalPaths exactly, giving fraction 1 with no special-casing.
    if (scope.result.kind !== "module") continue;
    for (const path of scope.inputPaths) {
      if (totalPaths.has(path)) exploredPaths.add(path);
    }
  }

  const totalFiles = totalPaths.size;
  return {
    totalFiles,
    exploredFiles: exploredPaths.size,
    fraction: totalFiles === 0 ? 1 : exploredPaths.size / totalFiles,
    gapScopeCount,
  };
};
