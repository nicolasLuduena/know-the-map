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
import { Effect, Layer, Schema } from "effect";
import { AnalysisBoundExceededError } from "./errors.ts";
import { Hermeneut, HermeneutLive } from "./hermeneut.ts";
import type { AnalysisArtifact } from "./schemas.ts";

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

const runAnalysis = async (script: ReadonlyArray<unknown>) => {
  const sent: Array<{ prompt: string; payload: unknown }> = [];
  const program = Effect.gen(function* () {
    const hermeneut = yield* Hermeneut;
    return yield* hermeneut.analyze();
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

const cohesive = (
  id: number,
  path: string,
  interpretations: ReadonlyArray<unknown> = [interpretation(id, path, 1, 2)],
) => ({
  kind: "cohesive",
  summary: `unit ${path}`,
  interpretations,
});

test("happy path: division then cohesive analyses produce the artifact", async () => {
  const { outcome, sent } = await runAnalysis([
    division(),
    cohesive(5, "src/a.ts", [
      interpretation(6, "src/a.ts", 5, 5, { kind: "other", customKind: "heuristic" }),
    ]),
    cohesive(7, "src/b.ts", [
      interpretation(8, "src/b.ts", 1, 2, { kind: "effect", text: "writes to stdout" }),
    ]),
  ]);

  expect(outcome._tag).toBe("Right");
  if (outcome._tag !== "Right") return;
  const artifact: AnalysisArtifact = outcome.right;
  expect(artifact.headCommit).toBe(FIXTURE.headCommit);
  expect(artifact.components.map((component) => component.name)).toEqual(["alpha", "beta"]);
  expect(artifact.relationships).toHaveLength(1);
  expect(artifact.interpretations).toHaveLength(3);
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
    cohesive(5, "src/a.ts"),
    cohesive(9, "src/b.ts"),
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
    cohesive(5, "src/a.ts"),
    cohesive(9, "src/b.ts"),
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
    cohesive(5, "src/a.ts"),
    cohesive(9, "src/b.ts"),
  ]);

  expect(outcome._tag).toBe("Right");
  expect(sent[1]?.prompt).toContain('"ghost" is not a component');
});

test("duplicated ids (within a response and across exchanges) trigger clarifications", async () => {
  const { outcome, sent } = await runAnalysis([
    division({
      components: [
        { id: 1, name: "alpha", summary: "does a", files: ["src/a.ts"] },
        { id: 1, name: "beta", summary: "does b", files: ["src/b.ts"] },
      ],
    }),
    division(),
    cohesive(2, "src/a.ts"),
    cohesive(10, "src/a.ts"),
    cohesive(11, "src/b.ts"),
  ]);

  expect(outcome._tag).toBe("Right");
  expect(sent[1]?.prompt).toContain("id 1 is not unique");
  expect(sent[3]?.prompt).toContain("id 2 is not unique");
  expect(sent).toHaveLength(5);
});

test(`kind "other" without customKind triggers a clarification`, async () => {
  const { outcome, sent } = await runAnalysis([
    division(),
    cohesive(5, "src/a.ts", [interpretation(6, "src/a.ts", 5, 5, { kind: "other" })]),
    cohesive(6, "src/a.ts", [
      interpretation(6, "src/a.ts", 5, 5, { kind: "other", customKind: "heuristic" }),
    ]),
    cohesive(9, "src/b.ts"),
  ]);

  expect(outcome._tag).toBe("Right");
  expect(sent[2]?.prompt).toContain("customKind");
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

test("reaching the harness-call bound fails loudly", async () => {
  const script: Array<unknown> = [
    division({
      components: Array.from({ length: 12 }, (_, index) => ({
        id: index + 1,
        name: `c${index}`,
        summary: "leaf",
        files: ["src/a.ts"],
      })),
      relationships: [],
      interpretations: [],
    }),
    ...Array.from({ length: 11 }, (_, index) => cohesive(20 + index, "src/a.ts")),
  ];
  const { outcome, sent } = await runAnalysis(script);

  expect(outcome._tag).toBe("Left");
  if (outcome._tag !== "Left") return;
  expect(outcome.left).toBeInstanceOf(AnalysisBoundExceededError);
  expect(outcome.left.message).toContain("12 harness calls");
  expect(sent).toHaveLength(12);
});

test("divisions nested beyond the max depth fail loudly", async () => {
  const nested = (base: number) =>
    division({
      components: [{ id: base, name: "inner", summary: "still divisible", files: ["src/a.ts"] }],
      relationships: [],
      interpretations: [],
    });
  const { outcome } = await runAnalysis([nested(1), nested(10), nested(20), nested(30)]);

  expect(outcome._tag).toBe("Left");
  if (outcome._tag !== "Left") return;
  expect(outcome.left).toBeInstanceOf(AnalysisBoundExceededError);
  expect(outcome.left.message).toContain("max depth");
});
