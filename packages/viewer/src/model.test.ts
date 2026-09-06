import { expect, test } from "bun:test";
import { AnalysisArtifact, type AnalysisScope } from "@know-the-map/hermeneut";
import { DateTime, Schema } from "effect";
import { buildViewerModel, matchingNodes } from "./model.ts";

const fixture = Schema.decodeUnknownSync(Schema.fromJsonString(AnalysisArtifact))(
  await Bun.file(new URL("../test-fixtures/analysis.json", import.meta.url)).text(),
);
const validate = Schema.decodeUnknownSync(Schema.toType(AnalysisArtifact));

const nested = (): AnalysisArtifact => {
  const root = fixture.scopes[0];
  const first = fixture.scopes[1];
  if (root === undefined || first === undefined) throw new Error("fixture scopes missing");
  const division: AnalysisScope = {
    ...first,
    result: {
      kind: "division",
      components: [
        {
          id: 1,
          name: "Product foundation",
          summary: "Nested with reused name and id",
          files: ["PRODUCT.md"],
        },
        { id: 2, name: "Readme", summary: "Second sibling", files: ["README.md"] },
      ],
      relationships: [
        {
          id: 3,
          from: "Readme",
          to: "Product foundation",
          kind: "uses",
          description: "Scoped link",
        },
      ],
      interpretations: [],
    },
  };
  const scopes: AnalysisScope[] = [
    root,
    division,
    {
      id: 4,
      parentScopeId: division.id,
      originatingComponentId: 1,
      inputPaths: ["PRODUCT.md"],
      result: { kind: "module", summary: "Leaf one", interpretations: [] },
    },
    {
      id: 5,
      parentScopeId: division.id,
      originatingComponentId: 2,
      inputPaths: ["README.md"],
      result: { kind: "module", summary: "Leaf two", interpretations: [] },
    },
    ...fixture.scopes.slice(2),
  ];
  return validate({
    ...fixture,
    scopes,
    components: scopes.flatMap((scope) =>
      scope.result.kind === "division" ? scope.result.components : [],
    ),
    relationships: scopes.flatMap((scope) =>
      scope.result.kind === "division" ? scope.result.relationships : [],
    ),
    interpretations: scopes.flatMap((scope) => scope.result.interpretations),
  });
};

test("hierarchy and search preserve repeated local ids/names and every sibling", () => {
  const model = buildViewerModel(nested());
  expect(model.nodes.map((node) => node.key)).toEqual(["1:1", "1:2"]);
  expect(model.byKey.get("2:1")?.parentKey).toBe("1:1");
  expect(model.byKey.get("2:2")?.childScope.result.kind).toBe("module");
  expect([...matchingNodes(model, "")].sort()).toEqual(["1:1", "1:2", "2:1", "2:2"]);
  expect([...matchingNodes(model, "readme")].sort()).toEqual(["1:1", "2:2"]);
  expect([...matchingNodes(model, "nonexistent")]).toEqual([]);
  expect(model.byKey.get("2:2")?.parentScope.result.kind).toBe("division");
});

test("artifact encoding preserves UTC time and scope summaries", () => {
  const encoded = Schema.encodeSync(AnalysisArtifact)(nested());
  const decoded = Schema.decodeUnknownSync(AnalysisArtifact)(JSON.parse(JSON.stringify(encoded)));
  expect(DateTime.formatIso(decoded.generatedAt)).toBe("2026-09-05T12:00:00.000Z");
  expect(decoded.scopes[2]?.result).toEqual({
    kind: "module",
    summary: "Leaf one",
    interpretations: [],
  });
});

test("a repository that is one module needs no synthetic component", () => {
  const artifact = validate({
    ...fixture,
    components: [],
    relationships: [],
    interpretations: [],
    scopes: [
      {
        id: 1,
        parentScopeId: null,
        originatingComponentId: null,
        inputPaths: fixture.files.map((file) => file.path),
        result: { kind: "module", summary: "One module", interpretations: [] },
      },
    ],
  });
  expect(buildViewerModel(artifact).nodes).toEqual([]);
  expect(buildViewerModel(artifact).rootScope.result.kind).toBe("module");
});

test("artifact rejects missing/duplicate children, invalid ownership, unreachable cycles and inconsistent flat claims", () => {
  const artifact = nested();
  expect(() => validate({ ...artifact, scopes: artifact.scopes.slice(0, -1) })).toThrow();
  expect(() =>
    validate({ ...artifact, scopes: [...artifact.scopes, { ...artifact.scopes[2], id: 99 }] }),
  ).toThrow();
  expect(() =>
    validate({
      ...artifact,
      scopes: artifact.scopes.map((scope) =>
        scope.id === 1 ? { ...scope, originatingComponentId: 1 } : scope,
      ),
    }),
  ).toThrow();
  expect(() =>
    validate({
      ...artifact,
      components: artifact.components.map((component) => ({ ...component, summary: "Changed" })),
    }),
  ).toThrow();
  expect(() => validate({ ...artifact, files: [] })).toThrow();
  expect(() =>
    validate({
      ...artifact,
      scopes: artifact.scopes.map((scope) =>
        scope.id === 2 ? { ...scope, parentScopeId: 2 } : scope,
      ),
    }),
  ).toThrow();
  const encoded = Schema.encodeSync(AnalysisArtifact)(fixture);
  expect(() =>
    Schema.decodeUnknownSync(AnalysisArtifact)({
      ...encoded,
      version: undefined,
      scopes: undefined,
    }),
  ).toThrow();
});
