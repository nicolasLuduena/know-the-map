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
import { defaultAnalysisBounds, Hermeneut, HermeneutLive } from "./hermeneut.ts";
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
    // Hermeneut's analysis path never reads a snapshot at an exact commit;
    // that's the viewer's job. `discover` mirrors `resolve` since this
    // fixture has no notion of a dirty worktree, and `readSnapshotFile`
    // fails loudly if a future caller ever reaches it unexpectedly.
    discover: () => Effect.succeed({ root: "/repo", headCommit: FIXTURE.headCommit }),
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
    readSnapshotFile: (_root, _commit, path) =>
      Effect.fail(
        new GitCommandError({
          message: `MockGit.readSnapshotFile is not implemented; unexpectedly asked for "${path}"`,
          cause: new Error(path),
        }),
      ),
  }),
);

/** Pops one scripted payload per `send`, in call order, across every session of the run. */
const scriptHarness = (
  script: ReadonlyArray<unknown>,
  sent: Array<{ prompt: string; payload: unknown }>,
): Layer.Layer<Harness> => {
  const queue = [...script];
  return Layer.succeed(
    Harness,
    Harness.of({
      listModels: () => Effect.succeed([]),
      start: () =>
        Effect.sync(() => {
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
};

/**
 * Serves a scripted payload per scope, keyed by the component that opened
 * it ("root" for the root scope), after a per-scope delay, and records the
 * session lifecycle. The delays let sibling scopes finish in an order
 * other than the one they were opened in.
 */
const keyedHarness = (
  responses: Readonly<Record<string, { readonly payload: unknown; readonly delayMs: number }>>,
  sent: Array<{ prompt: string; payload: unknown }>,
  sessions: { starts: number; closes: number; open: number; peak: number },
): Layer.Layer<Harness> =>
  Layer.succeed(
    Harness,
    Harness.of({
      listModels: () => Effect.succeed([]),
      start: () =>
        Effect.sync(() => {
          sessions.starts++;
          sessions.open++;
          sessions.peak = Math.max(sessions.peak, sessions.open);
          const session: HarnessSession = {
            send: <T, I>(exchange: HarnessExchange<T, I>): Effect.Effect<T, HarnessError> =>
              Effect.gen(function* () {
                const key = /component "([^"]+)"/.exec(exchange.prompt)?.[1] ?? "root";
                const response = responses[key];
                if (response === undefined) {
                  return yield* new NoSubmissionError({ message: `no script for "${key}"` });
                }
                yield* Effect.sleep(Duration.millis(response.delayMs));
                sent.push({ prompt: exchange.prompt, payload: response.payload });
                return yield* Schema.decodeUnknownEffect(exchange.resultSchema)(
                  response.payload,
                ).pipe(
                  Effect.mapError(
                    (cause) =>
                      new InvalidResultError({
                        message: "submit_result payload failed validation",
                        cause,
                      }),
                  ),
                );
              }),
            close: () =>
              Effect.sync(() => {
                sessions.closes++;
                sessions.open--;
              }),
          };
          return session;
        }),
    }),
  );

const analyzeWith = async (harness: Layer.Layer<Harness>, bounds: AnalysisBounds) => {
  const program = Effect.gen(function* () {
    const hermeneut = yield* Hermeneut;
    return yield* hermeneut.analyze(".", TEST_HARNESS_SELECTION, bounds);
  }).pipe(Effect.provide(HermeneutLive.pipe(Layer.provide(MockGit), Layer.provide(harness))));
  return Effect.runPromise(Effect.result(program)).then((result) =>
    result._tag === "Success"
      ? { _tag: "Right" as const, right: result.success }
      : { _tag: "Left" as const, left: result.failure },
  );
};

// The scripted fixtures pop payloads in call order, so they only mean what
// they say when scopes are explored one at a time.
const SEQUENTIAL_BOUNDS: AnalysisBounds = { ...defaultAnalysisBounds, maxConcurrency: 1 };

const runAnalysis = async (
  script: ReadonlyArray<unknown>,
  bounds: AnalysisBounds = SEQUENTIAL_BOUNDS,
) => {
  const sent: Array<{ prompt: string; payload: unknown }> = [];
  const outcome = await analyzeWith(scriptHarness(script, sent), bounds);
  return { outcome, sent };
};

const runKeyed = async (responses: Parameters<typeof keyedHarness>[0], bounds: AnalysisBounds) => {
  const sent: Array<{ prompt: string; payload: unknown }> = [];
  const sessions = { starts: 0, closes: 0, open: 0, peak: 0 };
  const outcome = await analyzeWith(keyedHarness(responses, sent, sessions), bounds);
  return { outcome, sent, sessions };
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
  // A child scope learns why it exists; the root has no such context.
  expect(sent[0]?.prompt).not.toContain('component "');
  expect(sent[1]?.prompt).toContain('component "alpha"');
  expect(sent[1]?.prompt).toContain("does a");
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
    maxConcurrency: 1,
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
    maxConcurrency: 1,
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
    maxConcurrency: 1,
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

test("a budget spent mid-tree still leaves every component with a child scope", async () => {
  // Three levels, and the budget runs out partway down the first branch:
  // the second branch is never explored at all. The decode below is the
  // real assertion — an artifact where any component lost its child scope
  // cannot pass the integrity checks.
  const { outcome, sent } = await runAnalysis(
    [
      division({
        components: [
          { id: 1, name: "alpha", summary: "does a", files: ["src/a.ts"] },
          { id: 2, name: "beta", summary: "does b", files: ["src/b.ts"] },
        ],
        relationships: [],
        interpretations: [],
      }),
      division({
        components: [{ id: 1, name: "inner", summary: "nested", files: ["src/a.ts"] }],
        relationships: [],
        interpretations: [],
      }),
      module(9, "src/a.ts"),
    ],
    { maxHarnessCalls: 3, maxDepth: 7, maxClarifications: 3, maxConcurrency: 1 },
  );

  expect(outcome._tag).toBe("Right");
  if (outcome._tag !== "Right") return;
  expect(sent).toHaveLength(3);
  expect(outcome.right.scopes.map((scope) => scope.result.kind)).toEqual([
    "division",
    "division",
    "module",
    "gap",
  ]);
  const encoded = Schema.encodeSync(AnalysisArtifact)(outcome.right);
  expect(Schema.decodeUnknownSync(AnalysisArtifact)(encoded).scopes).toHaveLength(4);
});

const SIBLINGS = [
  { id: 1, name: "alpha", summary: "does a", files: ["src/a.ts"] },
  { id: 2, name: "beta", summary: "does b", files: ["src/b.ts"] },
  { id: 3, name: "gamma", summary: "does a again", files: ["src/a.ts"] },
  { id: 4, name: "delta", summary: "does b again", files: ["src/b.ts"] },
];

/** Four siblings whose completion order is the reverse of their opening order. */
const FAN_OUT = {
  root: {
    payload: division({ components: SIBLINGS, relationships: [], interpretations: [] }),
    delayMs: 0,
  },
  alpha: { payload: module(10, "src/a.ts"), delayMs: 8 },
  beta: { payload: module(11, "src/b.ts"), delayMs: 6 },
  gamma: { payload: module(12, "src/a.ts"), delayMs: 4 },
  delta: { payload: module(13, "src/b.ts"), delayMs: 2 },
};

test("each scope gets its own session, siblings run at most maxConcurrency at a time, and the artifact does not depend on completion order", async () => {
  const concurrent = await runKeyed(FAN_OUT, { ...SEQUENTIAL_BOUNDS, maxConcurrency: 2 });
  const sequential = await runKeyed(FAN_OUT, SEQUENTIAL_BOUNDS);

  expect(concurrent.outcome._tag).toBe("Right");
  expect(sequential.outcome._tag).toBe("Right");
  if (concurrent.outcome._tag !== "Right" || sequential.outcome._tag !== "Right") return;
  // Root plus one child session per sibling, every one of them closed.
  expect(concurrent.sessions).toMatchObject({ starts: 5, closes: 5, open: 0, peak: 2 });
  expect(sequential.sessions).toMatchObject({ starts: 5, closes: 5, open: 0, peak: 1 });
  const { generatedAt: _c, ...concurrentArtifact } = concurrent.outcome.right;
  const { generatedAt: _s, ...sequentialArtifact } = sequential.outcome.right;
  expect(concurrentArtifact).toEqual(sequentialArtifact);
  const ids = concurrentArtifact.scopes.map((scope) => scope.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const scope of concurrentArtifact.scopes) {
    if (scope.parentScopeId !== null) {
      expect(ids.indexOf(scope.parentScopeId)).toBeLessThan(ids.indexOf(scope.id));
    }
  }
});

test("a budget that runs out mid-fan-out gaps only the siblings that got no call", async () => {
  const { outcome, sent, sessions } = await runKeyed(FAN_OUT, {
    ...SEQUENTIAL_BOUNDS,
    maxHarnessCalls: 3,
    maxConcurrency: 4,
  });

  expect(outcome._tag).toBe("Right");
  if (outcome._tag !== "Right") return;
  expect(sent).toHaveLength(3);
  // A scope that never gets a call never opens a session either.
  expect(sessions).toMatchObject({ starts: 3, closes: 3, open: 0 });
  const kinds = outcome.right.scopes.map((scope) => scope.result.kind);
  expect(kinds[0]).toBe("division");
  expect(kinds.filter((kind) => kind === "module")).toHaveLength(2);
  expect(kinds.filter((kind) => kind === "gap")).toHaveLength(2);
  expect(
    outcome.right.scopes.every(
      (scope) => scope.result.kind !== "gap" || scope.result.reason === "call_budget",
    ),
  ).toBe(true);
  const encoded = Schema.encodeSync(AnalysisArtifact)(outcome.right);
  expect(Schema.decodeUnknownSync(AnalysisArtifact)(encoded).scopes).toHaveLength(5);
});

test("the concurrency bound holds across nested divisions, not just within one", async () => {
  const branch = (base: number, prefix: string, path: string) => ({
    payload: division({
      components: [
        { id: base, name: `${prefix}1`, summary: "leaf", files: [path] },
        { id: base + 1, name: `${prefix}2`, summary: "leaf", files: [path] },
      ],
      relationships: [],
      interpretations: [],
    }),
    delayMs: 2,
  });
  const leaf = (id: number, path: string) => ({ payload: module(id, path), delayMs: 6 });
  const { outcome, sessions } = await runKeyed(
    {
      root: {
        payload: division({
          components: SIBLINGS.slice(0, 2),
          relationships: [],
          interpretations: [],
        }),
        delayMs: 0,
      },
      alpha: branch(10, "a", "src/a.ts"),
      beta: branch(20, "b", "src/b.ts"),
      a1: leaf(30, "src/a.ts"),
      a2: leaf(31, "src/a.ts"),
      b1: leaf(32, "src/b.ts"),
      b2: leaf(33, "src/b.ts"),
    },
    { ...SEQUENTIAL_BOUNDS, maxConcurrency: 2 },
  );

  expect(outcome._tag).toBe("Right");
  if (outcome._tag !== "Right") return;
  // Four leaves are ready at once; a per-division bound would let all four run.
  expect(sessions).toMatchObject({ starts: 7, closes: 7, open: 0, peak: 2 });
  expect(outcome.right.scopes).toHaveLength(7);
});
