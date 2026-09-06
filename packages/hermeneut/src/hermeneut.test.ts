import { expect, test } from "bun:test";
import { Git, GitCommandError, type GitError, type InventoryEntry } from "@know-the-map/git";
import {
  Harness,
  type HarnessError,
  type HarnessExchange,
  type HarnessSession,
  InvalidResultError,
  NoSubmissionError,
} from "@know-the-map/harness";
import { Duration, Effect, Layer, Schema } from "effect";
import type { AnalysisBounds, HarnessSelection } from "./hermeneut.ts";
import { Hermeneut, HermeneutLive } from "./hermeneut.ts";
import { AnalysisArtifact } from "./schemas.ts";

const TEST_HARNESS_SELECTION: HarnessSelection = {
  model: { providerId: "opencode-go", modelId: "deepseek-v4-flash" },
  turnTimeout: Duration.minutes(15),
  maxGenerationTokens: 32_768,
};

/**
 * The mock git service and the mock harness share this fixture: scripted
 * model payloads only reference what the mock git knows, so the
 * anti-hallucination validation has a deterministic oracle.
 */
const FIXTURE = {
  headCommit: "0123456789abcdef0123456789abcdef01234567",
  files: [
    { path: "src/a.ts", hash: "aaaa", lineCount: 10 },
    { path: "src/b.ts", hash: "bbbb", lineCount: 5 },
  ],
} as const;

const MockGit: Layer.Layer<Git> = Layer.succeed(
  Git,
  Git.of({
    resolve: () => Effect.succeed({ root: "/repo", headCommit: FIXTURE.headCommit }),
    inventory: (): Effect.Effect<ReadonlyArray<InventoryEntry>, GitError> =>
      Effect.succeed(FIXTURE.files.map(({ path, hash }) => ({ path, hash }))),
    lineCount: (_root, path) => {
      const file = FIXTURE.files.find((candidate) => candidate.path === path);
      return file === undefined
        ? Effect.fail(
            new GitCommandError({
              message: `unknown file "${path}"`,
              cause: new Error(path),
            }),
          )
        : Effect.succeed(file.lineCount);
    },
  }),
);

const scriptHarness = (
  script: ReadonlyArray<unknown>,
  sent: Array<{ prompt: string; payload: unknown }>,
): Layer.Layer<Harness> =>
  Layer.succeed(
    Harness,
    Harness.of({
      listModels: () => Effect.succeed([]),
      start: () =>
        Effect.sync(() => {
          const queue = [...script];
          const session: HarnessSession = {
            send: <T, I>(exchange: HarnessExchange<T, I>): Effect.Effect<T, HarnessError> =>
              Effect.gen(function* () {
                const payload = queue.shift();
                if (payload === undefined) {
                  return yield* new NoSubmissionError({
                    message: "script exhausted",
                  });
                }
                sent.push({ prompt: exchange.prompt, payload });
                return yield* Schema.decodeUnknownEffect(exchange.resultSchema)(payload).pipe(
                  Effect.mapError(
                    (cause) =>
                      new InvalidResultError({
                        message: "submit_result payload failed validation",
                        cause,
                      }),
                  ),
                );
              }),
            close: () => Effect.void,
          };
          return session;
        }),
    }),
  );

const runAnalysis = async (script: ReadonlyArray<unknown>, bounds?: AnalysisBounds) => {
  const sent: Array<{ prompt: string; payload: unknown }> = [];
  const program = Effect.gen(function* () {
    const hermeneut = yield* Hermeneut;
    return yield* hermeneut.analyze(".", TEST_HARNESS_SELECTION, bounds);
  }).pipe(
    Effect.provide(
      HermeneutLive.pipe(Layer.provide(MockGit), Layer.provide(scriptHarness(script, sent))),
    ),
  );
  const outcome = await Effect.runPromise(Effect.result(program)).then((result) =>
    result._tag === "Success"
      ? { _tag: "Right" as const, right: result.success }
      : { _tag: "Left" as const, left: result.failure },
  );
  return { outcome, sent };
};

const interpretation = (
  id: number,
  path: string,
  lineStart: number,
  lineEnd: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  kind: "invariant",
  text: "holds always",
  anchors: [{ path, lineStart, lineEnd }],
  ...extra,
});

const division = (
  overrides: {
    readonly components?: ReadonlyArray<unknown>;
    readonly relationships?: ReadonlyArray<unknown>;
    readonly interpretations?: ReadonlyArray<unknown>;
  } = {},
) => ({
  kind: "division",
  components: overrides.components ?? [
    { id: 1, name: "alpha", summary: "does a", files: ["src/a.ts"] },
    { id: 2, name: "beta", summary: "does b", files: ["src/b.ts"] },
  ],
  relationships: overrides.relationships ?? [
    { id: 3, from: "alpha", to: "beta", kind: "uses", description: "alpha uses beta" },
  ],
  interpretations: overrides.interpretations ?? [interpretation(4, "src/a.ts", 1, 3)],
});

const module = (
  id: number,
  path: string,
  interpretations: ReadonlyArray<unknown> = [interpretation(id, path, 1, 2)],
) => ({
  kind: "module",
  summary: `unit ${path}`,
  interpretations,
});

test("happy path: division then module analyses produce the artifact", async () => {
  const { outcome, sent } = await runAnalysis([
    division(),
    module(5, "src/a.ts", [
      interpretation(6, "src/a.ts", 5, 5, { kind: "other", customKind: "heuristic" }),
    ]),
    module(7, "src/b.ts", [
      interpretation(8, "src/b.ts", 1, 2, { kind: "effect", text: "writes to stdout" }),
    ]),
  ]);

  expect(outcome._tag).toBe("Right");
  if (outcome._tag !== "Right") return;
  const artifact: AnalysisArtifact = outcome.right;
  expect(artifact.headCommit).toBe(FIXTURE.headCommit);
  expect(artifact.version).toBe(1);
  const root = artifact.scopes[0];
  if (root?.result.kind !== "division") throw new Error("root scope should be a division");
  expect(root.result.components.map((component) => component.name)).toEqual(["alpha", "beta"]);
  expect(root.result.relationships).toHaveLength(1);
  expect(
    artifact.scopes.reduce(
      (total, scope) =>
        total + (scope.result.kind === "gap" ? 0 : scope.result.interpretations.length),
      0,
    ),
  ).toBe(3);
  expect(artifact.files).toEqual([
    { path: "src/a.ts", hash: "aaaa", lineCount: 10 },
    { path: "src/b.ts", hash: "bbbb", lineCount: 5 },
  ]);
  expect(sent).toHaveLength(3);
  expect(sent[0]?.prompt).toContain("src/a.ts");
});

test("hallucinated file path triggers a clarification, then the run recovers", async () => {
  const { outcome, sent } = await runAnalysis([
    division({
      components: [
        { id: 1, name: "alpha", summary: "does a", files: ["src/ghost.ts"] },
        { id: 2, name: "beta", summary: "does b", files: ["src/b.ts"] },
      ],
    }),
    division(),
    module(5, "src/a.ts"),
    module(9, "src/b.ts"),
  ]);

  expect(outcome._tag).toBe("Right");
  expect(sent).toHaveLength(4);
  expect(sent[1]?.prompt).toContain("Clarification required");
  expect(sent[1]?.prompt).toContain("src/ghost.ts");
  expect(sent[1]?.prompt).toContain("claim 1");
});

test("line range past the end of the file triggers a clarification", async () => {
  const { outcome, sent } = await runAnalysis([
    division({
      interpretations: [interpretation(4, "src/a.ts", 1, 11)],
    }),
    division(),
    module(5, "src/a.ts"),
    module(9, "src/b.ts"),
  ]);

  expect(outcome._tag).toBe("Right");
  expect(sent[1]?.prompt).toContain("10 lines");
});

test("relationship with an unknown endpoint triggers a clarification", async () => {
  const { outcome, sent } = await runAnalysis([
    division({
      relationships: [{ id: 3, from: "alpha", to: "ghost", kind: "uses", description: "made up" }],
    }),
    division(),
    module(5, "src/a.ts"),
    module(9, "src/b.ts"),
  ]);

  expect(outcome._tag).toBe("Right");
  expect(sent[1]?.prompt).toContain('"ghost" is not a component');
});

test("duplicated ids within a response trigger a contract clarification", async () => {
  const { outcome, sent } = await runAnalysis([
    division({
      components: [
        { id: 1, name: "alpha", summary: "does a", files: ["src/a.ts"] },
        { id: 1, name: "beta", summary: "does b", files: ["src/b.ts"] },
      ],
    }),
    division(),
    module(2, "src/a.ts"),
    module(2, "src/b.ts"),
  ]);

  expect(outcome._tag).toBe("Right");
  expect(sent).toHaveLength(4);
  expect(sent[1]?.prompt).toContain("not unique within this answer");
});

test(`kind "other" without customKind triggers a clarification`, async () => {
  const { outcome, sent } = await runAnalysis([
    division(),
    module(5, "src/a.ts", [interpretation(6, "src/a.ts", 5, 5, { kind: "other" })]),
    module(6, "src/a.ts", [
      interpretation(6, "src/a.ts", 5, 5, { kind: "other", customKind: "heuristic" }),
    ]),
    module(9, "src/b.ts"),
  ]);

  expect(outcome._tag).toBe("Right");
  expect(sent[2]?.prompt).toContain("customKind");
});

test("a payload that fails the answer contract triggers a clarification, then the run recovers", async () => {
  const { outcome, sent } = await runAnalysis([
    { kind: "nonsense" },
    division(),
    module(5, "src/a.ts"),
    module(9, "src/b.ts"),
  ]);

  expect(outcome._tag).toBe("Right");
  expect(sent).toHaveLength(4);
  expect(sent[1]?.prompt).toContain("did not match the required answer");
});

test("unfixable responses exhaust the clarification bound and fail loudly", async () => {
  const { outcome } = await runAnalysis([
    division({
      components: [{ id: 1, name: "alpha", summary: "does a", files: ["src/ghost.ts"] }],
      relationships: [],
      interpretations: [],
    }),
    division({
      components: [{ id: 2, name: "alpha", summary: "does a", files: ["src/phantom.ts"] }],
      relationships: [],
      interpretations: [],
    }),
    division({
      components: [{ id: 3, name: "alpha", summary: "does a", files: ["src/specter.ts"] }],
      relationships: [],
      interpretations: [],
    }),
    division({
      components: [{ id: 4, name: "alpha", summary: "does a", files: ["src/wraith.ts"] }],
      relationships: [],
      interpretations: [],
    }),
  ]);

  expect(outcome._tag).toBe("Left");
  if (outcome._tag !== "Left") return;
  expect(outcome.left).toBeInstanceOf(InvalidResultError);
  expect(outcome.left.message).toContain("clarification round(s)");
});

test("reaching the harness-call bound records a gap instead of failing the run", async () => {
  const componentCount = 48;
  const script: Array<unknown> = [
    division({
      components: Array.from({ length: componentCount }, (_, index) => ({
        id: index + 1,
        name: `c${index}`,
        summary: "leaf",
        files: ["src/a.ts"],
      })),
      relationships: [],
      interpretations: [],
    }),
    // One fewer module than components: the last component's exchange call
    // is the one that finds the budget already spent.
    ...Array.from({ length: componentCount - 1 }, (_, index) => module(100 + index, "src/a.ts")),
  ];
  const { outcome, sent } = await runAnalysis(script);

  expect(outcome._tag).toBe("Right");
  if (outcome._tag !== "Right") return;
  // Every scripted exchange was still spent — nothing paid for is thrown away.
  expect(sent).toHaveLength(48);
  const gaps = outcome.right.scopes.filter((scope) => scope.result.kind === "gap");
  expect(gaps).toHaveLength(1);
  const [gap] = gaps;
  if (gap === undefined || gap.result.kind !== "gap") throw new Error("expected a gap scope");
  expect(gap.originatingComponentId).toBe(componentCount);
  expect(gap.result.reason).toBe("call_budget");
  expect(gap.result.message).toContain("48 model calls");
});

test("a custom maxHarnessCalls bound is honored, not just the default", async () => {
  const script: Array<unknown> = [
    division({
      components: Array.from({ length: 3 }, (_, index) => ({
        id: index + 1,
        name: `c${index}`,
        summary: "leaf",
        files: ["src/a.ts"],
      })),
      relationships: [],
      interpretations: [],
    }),
    module(100, "src/a.ts"),
  ];
  const { outcome, sent } = await runAnalysis(script, {
    maxHarnessCalls: 2,
    maxDepth: 3,
    maxClarifications: 3,
  });

  expect(outcome._tag).toBe("Right");
  if (outcome._tag !== "Right") return;
  expect(sent).toHaveLength(2);
  const gaps = outcome.right.scopes.filter((scope) => scope.result.kind === "gap");
  expect(gaps).toHaveLength(2);
  expect(
    gaps.every((scope) => scope.result.kind === "gap" && scope.result.reason === "call_budget"),
  ).toBe(true);
});

test("a division at the depth bound keeps its own answer and gaps each of its components", async () => {
  const nested = (base: number) =>
    division({
      components: [{ id: base, name: "inner", summary: "still divisible", files: ["src/a.ts"] }],
      relationships: [],
      interpretations: [],
    });
  const { outcome, sent } = await runAnalysis([nested(1), nested(10), nested(20), nested(30)], {
    maxHarnessCalls: 48,
    maxDepth: 3,
    maxClarifications: 3,
  });

  expect(outcome._tag).toBe("Right");
  if (outcome._tag !== "Right") return;
  expect(sent).toHaveLength(4);
  const scopes = outcome.right.scopes;
  // The division at depth 3 (the bound) is scope 4, in pre-order: it was
  // already paid for, so it is kept as-is rather than discarded.
  const deepest = scopes[3];
  expect(deepest?.result.kind).toBe("division");
  const gapScopes = scopes.filter((scope) => scope.result.kind === "gap");
  expect(gapScopes).toHaveLength(1);
  expect(gapScopes[0]?.parentScopeId).toBe(deepest?.id);
  expect(gapScopes[0]?.originatingComponentId).toBe(30);
  expect(gapScopes[0]?.result).toMatchObject({ kind: "gap", reason: "depth_exceeded" });
});

test("an artifact containing gap scopes still satisfies the artifact schema's integrity checks", async () => {
  const script: Array<unknown> = [
    division({
      components: [
        { id: 1, name: "alpha", summary: "does a", files: ["src/a.ts"] },
        { id: 2, name: "beta", summary: "does b", files: ["src/b.ts"] },
      ],
      relationships: [],
      interpretations: [],
    }),
    module(5, "src/a.ts"),
  ];
  const { outcome } = await runAnalysis(script, {
    maxHarnessCalls: 2,
    maxDepth: 7,
    maxClarifications: 3,
  });

  expect(outcome._tag).toBe("Right");
  if (outcome._tag !== "Right") return;
  const encoded = Schema.encodeSync(AnalysisArtifact)(outcome.right);
  const decoded = Schema.decodeUnknownSync(AnalysisArtifact)(encoded);
  expect(decoded.scopes.filter((scope) => scope.result.kind === "gap")).toHaveLength(1);
});

test("scopes record provenance and survive model-local ids repeating across answers", async () => {
  const { outcome, sent } = await runAnalysis([
    division(),
    division({
      // Reuses id 1 and a component name from the root division: ids are
      // only unique within one answer, so provenance must not rely on them.
      components: [{ id: 1, name: "alpha", summary: "nested alpha", files: ["src/a.ts"] }],
      relationships: [],
      interpretations: [],
    }),
    module(1, "src/a.ts"),
    module(1, "src/b.ts"),
  ]);

  expect(outcome._tag).toBe("Right");
  if (outcome._tag !== "Right") throw new Error("analysis failed");
  expect(sent).toHaveLength(4);
  expect(
    outcome.right.scopes.map(({ id, parentScopeId, originatingComponentId }) => ({
      id,
      parentScopeId,
      originatingComponentId,
    })),
  ).toEqual([
    { id: 1, parentScopeId: null, originatingComponentId: null },
    { id: 2, parentScopeId: 1, originatingComponentId: 1 },
    { id: 3, parentScopeId: 2, originatingComponentId: 1 },
    { id: 4, parentScopeId: 1, originatingComponentId: 2 },
  ]);
  expect(outcome.right.scopes[2]?.result.kind).toBe("module");
});

test("a produced artifact satisfies the artifact schema's own integrity checks", async () => {
  const { outcome } = await runAnalysis([division(), module(5, "src/a.ts"), module(7, "src/b.ts")]);

  expect(outcome._tag).toBe("Right");
  if (outcome._tag !== "Right") throw new Error("analysis failed");
  // Round-tripping proves the emitted value is not merely well-typed but
  // passes every cross-field check: one root, one child scope per
  // component, and no path outside the recorded inventory.
  const encoded = Schema.encodeSync(AnalysisArtifact)(outcome.right);
  expect(Schema.decodeUnknownSync(AnalysisArtifact)(encoded).scopes).toHaveLength(3);
});

/**
 * A tree that satisfies every integrity check, handed back with its scopes
 * named so the mutations below can corrupt one invariant at a time without
 * indexing into the array.
 */
const fixture = () => {
  const alpha = { id: 1, name: "alpha", summary: "does a", files: ["src/a.ts"] };
  const root = {
    id: 1,
    parentScopeId: null as number | null,
    originatingComponentId: null as number | null,
    inputPaths: ["src/a.ts"] as ReadonlyArray<string>,
    result: {
      kind: "division",
      components: [alpha],
      relationships: [] as ReadonlyArray<unknown>,
      interpretations: [] as ReadonlyArray<unknown>,
    },
  };
  const leaf = {
    id: 2,
    parentScopeId: 1 as number | null,
    originatingComponentId: 1 as number | null,
    inputPaths: ["src/a.ts"] as ReadonlyArray<string>,
    // Cast so `result` can be swapped for a gap-shaped object below: the
    // fixture's own module/division checks don't care which kind occupies
    // this slot, only that the tree-shape invariants still hold around it.
    result: {
      kind: "module",
      summary: "unit a",
      interpretations: [] as ReadonlyArray<unknown>,
    } as Record<string, unknown>,
  };
  const artifact = {
    version: 1,
    headCommit: FIXTURE.headCommit,
    generatedAt: "2026-09-05T12:00:00.000Z",
    files: [{ path: "src/a.ts", hash: "aaaa", lineCount: 10 }],
    scopes: [root, leaf] as Array<unknown>,
  };
  return { artifact, root, leaf };
};
type Fixture = ReturnType<typeof fixture>;

test("the artifact schema accepts a well-formed tree", () => {
  expect(Schema.decodeUnknownSync(AnalysisArtifact)(fixture().artifact).scopes).toHaveLength(2);
});

test.each([
  [
    "two root scopes",
    "exactly one root scope",
    ({ leaf }: Fixture) => {
      leaf.parentScopeId = null;
      leaf.originatingComponentId = null;
    },
  ],
  [
    "a root that claims a parent component",
    "root scope cannot originate from a component",
    ({ root }: Fixture) => {
      root.originatingComponentId = 1;
    },
  ],
  [
    "a duplicate scope id",
    "duplicate scope id 1",
    ({ leaf }: Fixture) => {
      leaf.id = 1;
    },
  ],
  [
    "a scope orphaned from its parent",
    "does not originate from a component of a division scope",
    ({ leaf }: Fixture) => {
      leaf.originatingComponentId = 99;
    },
  ],
  [
    "input paths that drifted from the originating component",
    "differ from the component that opened it",
    ({ leaf }: Fixture) => {
      leaf.inputPaths = [];
    },
  ],
  [
    "a gap scope whose input paths drifted from the originating component",
    "differ from the component that opened it",
    ({ leaf }: Fixture) => {
      leaf.result = { kind: "gap", reason: "call_budget", message: "budget exhausted" };
      leaf.inputPaths = [];
    },
  ],
  [
    "a path outside the recorded inventory",
    "missing from the file inventory",
    ({ artifact }: Fixture) => {
      artifact.files = [];
    },
  ],
  [
    "a duplicated inventory path",
    "duplicate paths",
    ({ artifact }: Fixture) => {
      artifact.files = [...artifact.files, { path: "src/a.ts", hash: "aaaa", lineCount: 10 }];
    },
  ],
  [
    "an unexplored component",
    "has no analyzed child scope",
    ({ root }: Fixture) => {
      root.result.components = [
        ...root.result.components,
        { id: 2, name: "beta", summary: "does b", files: ["src/a.ts"] },
      ];
    },
  ],
  [
    "a scope unreachable from the root",
    "cycle or an unreachable scope",
    ({ artifact, root }: Fixture) => {
      // Scope 3 is its own parent, so no path from the root ever reaches it.
      root.result.components = [
        ...root.result.components,
        { id: 2, name: "beta", summary: "does b", files: ["src/a.ts"] },
      ];
      artifact.scopes = [
        ...artifact.scopes,
        {
          id: 3,
          parentScopeId: 3,
          originatingComponentId: 2,
          inputPaths: ["src/a.ts"],
          result: { kind: "module", summary: "unit b", interpretations: [] },
        },
      ];
    },
  ],
])("the artifact schema rejects %s", (_name, expected, corrupt) => {
  const built = fixture();
  corrupt(built);
  expect(() => Schema.decodeUnknownSync(AnalysisArtifact)(built.artifact)).toThrow(expected);
});
