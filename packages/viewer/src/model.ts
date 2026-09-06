import type { AnalysisArtifact, AnalysisScope, Component } from "@know-the-map/hermeneut";

export const ROOT_KEY = "root" as const;

export interface ComponentNode {
  readonly key: string;
  readonly scopeId: number;
  readonly parentKey: string;
  readonly parentScope: AnalysisScope;
  readonly component: Component;
  readonly childScope: AnalysisScope;
  readonly children: ReadonlyArray<ComponentNode>;
}

export interface ViewerModel {
  readonly rootScope: AnalysisScope;
  readonly nodes: ReadonlyArray<ComponentNode>;
  readonly byKey: ReadonlyMap<string, ComponentNode>;
}

export const componentKey = (scopeId: number, componentId: number): string =>
  `${scopeId}:${componentId}`;

export const buildViewerModel = (artifact: AnalysisArtifact): ViewerModel => {
  const byScopeId = new Map<number, AnalysisScope>();
  for (const scope of artifact.scopes) {
    byScopeId.set(scope.id, scope);
  }
  const roots = artifact.scopes.filter((scope) => scope.parentScopeId === null);
  const rootScope = roots[0];
  if (rootScope === undefined) throw new Error("validated artifact has no root scope");

  const childScopes = new Map<string, AnalysisScope>();
  for (const scope of artifact.scopes) {
    if (scope.parentScopeId === null) continue;
    const parent = byScopeId.get(scope.parentScopeId);
    if (parent === undefined || parent.result.kind !== "division") {
      throw new Error(`validated scope ${scope.id} has an invalid parent`);
    }
    const componentId = scope.originatingComponentId;
    const component = parent.result.components.find((candidate) => candidate.id === componentId);
    if (component === undefined) {
      throw new Error(`validated scope ${scope.id} references a missing parent component`);
    }
    if (component.files.join("\0") !== scope.inputPaths.join("\0")) {
      throw new Error(`validated scope ${scope.id} has inconsistent input paths`);
    }
    const key = componentKey(parent.id, component.id);
    if (childScopes.has(key))
      throw new Error(`validated component ${key} has multiple child scopes`);
    childScopes.set(key, scope);
  }

  const byKey = new Map<string, ComponentNode>();
  const visiting = new Set<number>();
  const build = (scope: AnalysisScope, parentKey: string): ReadonlyArray<ComponentNode> => {
    if (visiting.has(scope.id)) throw new Error("validated scope hierarchy contains a cycle");
    if (scope.result.kind === "module") return [];
    visiting.add(scope.id);
    const nodes = scope.result.components.map((component) => {
      const key = componentKey(scope.id, component.id);
      const childScope = childScopes.get(key);
      if (childScope === undefined)
        throw new Error(`validated component ${key} has no analyzed scope`);
      const node = {
        key,
        scopeId: scope.id,
        parentKey,
        parentScope: scope,
        component,
        childScope,
        children: build(childScope, key),
      };
      byKey.set(key, node);
      return node;
    });
    visiting.delete(scope.id);
    return nodes;
  };
  const nodes = build(rootScope, ROOT_KEY);
  return { rootScope, nodes, byKey };
};

export const matchingNodes = (model: ViewerModel, query: string): ReadonlySet<string> => {
  const visible = new Set<string>();
  const needle = query.trim().toLocaleLowerCase();
  const visit = (node: ComponentNode): boolean => {
    const childrenMatch = node.children.map(visit).some(Boolean);
    const matches =
      node.component.name.toLocaleLowerCase().includes(needle) ||
      node.component.files.some((path) => path.toLocaleLowerCase().includes(needle));
    if (matches || childrenMatch) visible.add(node.key);
    return matches || childrenMatch;
  };
  model.nodes.forEach(visit);
  return visible;
};
