import { expect, test } from "bun:test";
import { AnalysisArtifact, type GapReason } from "@know-the-map/hermeneut";
import { Schema } from "effect";
import { buildViewerModel, coverage, matchingNodes } from "./index.ts";

const component = (id: number, name: string, files: ReadonlyArray<string>) => ({
  id,
  name,
  summary: `${name} summary`,
  files,
});

const division = (
  id: number,
  parentScopeId: number | null,
  originatingComponentId: number | null,
  inputPaths: ReadonlyArray<string>,
  components: ReadonlyArray<ReturnType<typeof component>>,
) => ({
  id,
  parentScopeId,
  originatingComponentId,
  inputPaths,
  result: {
    kind: "division" as const,
    components,
    relationships: [] as ReadonlyArray<unknown>,
    interpretations: [] as ReadonlyArray<unknown>,
  },
});

const moduleScope = (
  id: number,
  parentScopeId: number,
  originatingComponentId: number,
  inputPaths: ReadonlyArray<string>,
) => ({
  id,
  parentScopeId,
  originatingComponentId,
  inputPaths,
  result: {
    kind: "module" as const,
    summary: `module ${id}`,
    interpretations: [] as ReadonlyArray<unknown>,
  },
});

const gapScope = (
  id: number,
  parentScopeId: number,
  originatingComponentId: number,
  inputPaths: ReadonlyArray<string>,
  reason: GapReason = "call_budget",
) => ({
  id,
  parentScopeId,
  originatingComponentId,
  inputPaths,
  result: {
    kind: "gap" as const,
    reason,
    message: `gap on scope ${id}`,
  },
});

const buildArtifact = (scopes: ReadonlyArray<unknown>, files: ReadonlyArray<string>) => ({
  version: 1 as const,
  headCommit: "0".repeat(40),
  generatedAt: "2026-09-06T00:00:00.000Z",
  files: files.map((path) => ({ path, hash: "hash", lineCount: 1 })),
  scopes,
});

// Decoding through `AnalysisArtifact` proves every fixture below could
// actually be produced and saved: a fixture that fails the schema's own
// integrity checks is not a valid test of the viewer.
const decode = (raw: unknown) => Schema.decodeUnknownSync(AnalysisArtifact)(raw);

test("builds a multi-level tree with correct parent/child links", () => {
  const artifact = decode(
    buildArtifact(
      [
        division(
          1,
          null,
          null,
          ["src/a.ts", "src/b.ts"],
          [component(10, "alpha", ["src/a.ts"]), component(20, "beta", ["src/b.ts"])],
        ),
        division(2, 1, 10, ["src/a.ts"], [component(1, "gamma", ["src/a.ts"])]),
        moduleScope(3, 1, 20, ["src/b.ts"]),
        moduleScope(4, 2, 1, ["src/a.ts"]),
      ],
      ["src/a.ts", "src/b.ts"],
    ),
  );

  const model = buildViewerModel(artifact);

  expect(model.roots.map((node) => node.key)).toEqual(["1:10", "1:20"]);

  const alpha = model.nodesByKey.get("1:10");
  const beta = model.nodesByKey.get("1:20");
  const gamma = model.nodesByKey.get("2:1");
  expect(alpha?.parentKey).toBeNull();
  expect(beta?.parentKey).toBeNull();
  expect(alpha?.leaf).toBeNull(); // opened a division, so it has children instead
  expect(alpha?.children.map((node) => node.key)).toEqual(["2:1"]);
  expect(gamma?.parentKey).toBe("1:10");
  expect(gamma?.leaf).toEqual({ kind: "explored" });
  expect(beta?.leaf).toEqual({ kind: "explored" });
  expect(model.nodesByKey.size).toBe(3);
});

test("component ids repeating across scopes resolve to distinct nodes", () => {
  const artifact = decode(
    buildArtifact(
      [
        division(
          1,
          null,
          null,
          ["src/a.ts", "src/b.ts"],
          [component(1, "compA", ["src/a.ts"]), component(2, "compB", ["src/b.ts"])],
        ),
        // Reuses component id 1, already used by the root division.
        division(2, 1, 1, ["src/a.ts"], [component(1, "compC", ["src/a.ts"])]),
        moduleScope(3, 1, 2, ["src/b.ts"]),
        moduleScope(4, 2, 1, ["src/a.ts"]),
      ],
      ["src/a.ts", "src/b.ts"],
    ),
  );

  const model = buildViewerModel(artifact);

  expect(model.nodesByKey.size).toBe(3);
  const compA = model.nodesByKey.get("1:1");
  const compC = model.nodesByKey.get("2:1");
  expect(compA).toBeDefined();
  expect(compC).toBeDefined();
  expect(compA).not.toBe(compC);
  expect(compA?.component.name).toBe("compA");
  expect(compC?.component.name).toBe("compC");
  expect(compC?.parentKey).toBe("1:1");
});

test("component names repeating across scopes resolve to distinct nodes", () => {
  const artifact = decode(
    buildArtifact(
      [
        division(
          1,
          null,
          null,
          ["src/a.ts", "src/b.ts"],
          [component(1, "worker", ["src/a.ts"]), component(2, "other", ["src/b.ts"])],
        ),
        division(2, 1, 1, ["src/a.ts"], [component(9, "worker", ["src/a.ts"])]),
        moduleScope(3, 1, 2, ["src/b.ts"]),
        moduleScope(4, 2, 9, ["src/a.ts"]),
      ],
      ["src/a.ts", "src/b.ts"],
    ),
  );

  const model = buildViewerModel(artifact);

  const outerWorker = model.nodesByKey.get("1:1");
  const innerWorker = model.nodesByKey.get("2:9");
  expect(outerWorker?.component.name).toBe("worker");
  expect(innerWorker?.component.name).toBe("worker");
  expect(outerWorker).not.toBe(innerWorker);
});

test("a gap leaf is distinguishable from an explored (module) leaf", () => {
  const artifact = decode(
    buildArtifact(
      [
        division(
          1,
          null,
          null,
          ["src/a.ts", "src/b.ts"],
          [component(1, "explored", ["src/a.ts"]), component(2, "unexplored", ["src/b.ts"])],
        ),
        moduleScope(2, 1, 1, ["src/a.ts"]),
        gapScope(3, 1, 2, ["src/b.ts"], "depth_exceeded"),
      ],
      ["src/a.ts", "src/b.ts"],
    ),
  );

  const model = buildViewerModel(artifact);

  const exploredNode = model.nodesByKey.get("1:1");
  const gapNode = model.nodesByKey.get("1:2");
  expect(exploredNode?.leaf).toEqual({ kind: "explored" });
  expect(gapNode?.leaf).toEqual({
    kind: "gap",
    reason: "depth_exceeded",
    message: "gap on scope 3",
  });
  expect(exploredNode?.children).toHaveLength(0);
  expect(gapNode?.children).toHaveLength(0);
});

test("matchingNodes keeps ancestors of a match visible", () => {
  const artifact = decode(
    buildArtifact(
      [
        division(
          1,
          null,
          null,
          ["src/a.ts", "src/b.ts"],
          [component(1, "outer", ["src/a.ts"]), component(2, "sibling", ["src/b.ts"])],
        ),
        division(2, 1, 1, ["src/a.ts"], [component(1, "needle", ["src/a.ts"])]),
        moduleScope(3, 2, 1, ["src/a.ts"]),
        moduleScope(4, 1, 2, ["src/b.ts"]),
      ],
      ["src/a.ts", "src/b.ts"],
    ),
  );

  const model = buildViewerModel(artifact);
  const visible = matchingNodes(model, "needle");

  expect(visible.has("2:1")).toBe(true); // the match itself
  expect(visible.has("1:1")).toBe(true); // its ancestor ("outer")
  expect(visible.has("1:2")).toBe(false); // unrelated sibling stays hidden
});

test("matchingNodes matches on a file path as well as a name", () => {
  const artifact = decode(
    buildArtifact(
      [
        division(
          1,
          null,
          null,
          ["src/special-path.ts", "src/b.ts"],
          [component(1, "alpha", ["src/special-path.ts"]), component(2, "beta", ["src/b.ts"])],
        ),
        moduleScope(2, 1, 1, ["src/special-path.ts"]),
        moduleScope(3, 1, 2, ["src/b.ts"]),
      ],
      ["src/special-path.ts", "src/b.ts"],
    ),
  );

  const model = buildViewerModel(artifact);
  const visible = matchingNodes(model, "SPECIAL-PATH");

  expect(visible.has("1:1")).toBe(true);
  expect(visible.has("1:2")).toBe(false);
});

test("an empty or whitespace query shows every node", () => {
  const artifact = decode(
    buildArtifact(
      [
        division(
          1,
          null,
          null,
          ["src/a.ts", "src/b.ts"],
          [component(1, "alpha", ["src/a.ts"]), component(2, "beta", ["src/b.ts"])],
        ),
        moduleScope(2, 1, 1, ["src/a.ts"]),
        moduleScope(3, 1, 2, ["src/b.ts"]),
      ],
      ["src/a.ts", "src/b.ts"],
    ),
  );

  const model = buildViewerModel(artifact);

  expect(matchingNodes(model, "")).toEqual(new Set(model.nodesByKey.keys()));
  expect(matchingNodes(model, "   ")).toEqual(new Set(model.nodesByKey.keys()));
});

test("coverage counts explored files and gaps across a tree with gaps", () => {
  const artifact = decode(
    buildArtifact(
      [
        division(
          1,
          null,
          null,
          ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
          [
            component(1, "compA", ["src/a.ts", "src/b.ts"]),
            component(2, "compB", ["src/c.ts"]),
            component(3, "compC", ["src/d.ts"]),
          ],
        ),
        division(
          2,
          1,
          1,
          ["src/a.ts", "src/b.ts"],
          [component(1, "compA1", ["src/a.ts"]), component(2, "compA2", ["src/b.ts"])],
        ),
        moduleScope(3, 2, 1, ["src/a.ts"]),
        gapScope(4, 2, 2, ["src/b.ts"]),
        moduleScope(5, 1, 2, ["src/c.ts"]),
        gapScope(6, 1, 3, ["src/d.ts"]),
      ],
      ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
    ),
  );

  const summary = coverage(artifact);

  expect(summary.totalFiles).toBe(4);
  expect(summary.exploredFiles).toBe(2);
  expect(summary.fraction).toBeCloseTo(0.5);
  expect(summary.gapScopeCount).toBe(2);
});

test("coverage on a single-module root artifact treats the root as fully explored", () => {
  const artifact = decode({
    version: 1 as const,
    headCommit: "0".repeat(40),
    generatedAt: "2026-09-06T00:00:00.000Z",
    files: [
      { path: "src/a.ts", hash: "hash", lineCount: 1 },
      { path: "src/b.ts", hash: "hash", lineCount: 1 },
    ],
    scopes: [
      {
        id: 1,
        parentScopeId: null,
        originatingComponentId: null,
        inputPaths: ["src/a.ts", "src/b.ts"],
        result: {
          kind: "module" as const,
          summary: "the whole tiny repo",
          interpretations: [] as ReadonlyArray<unknown>,
        },
      },
    ],
  });

  const summary = coverage(artifact);

  expect(summary.totalFiles).toBe(2);
  expect(summary.exploredFiles).toBe(2);
  expect(summary.fraction).toBe(1);
  expect(summary.gapScopeCount).toBe(0);
});
