import { Git, type GitError } from "@know-the-map/git";
import {
  Harness,
  type HarnessError,
  type HarnessSession,
  type HarnessSessionConfig,
  InvalidResultError,
} from "@know-the-map/harness";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { AnalysisBoundExceededError } from "./errors.ts";
import {
  clarificationPrompt,
  contractClarificationPrompt,
  SYSTEM_PROMPT,
  scopePrompt,
} from "./prompts.ts";
import type {
  AnalysisArtifact,
  AnalysisScope,
  Component,
  FileStatus,
  ScopeResult,
} from "./schemas.ts";
import { LlmResponse, PositiveInt } from "./schemas.ts";
import { validateResponse } from "./validation.ts";

/** Per-run bounds on the analysis loop: how much model budget and division
 * depth one `analyze()` call may spend before it stops itself. */
export const AnalysisBounds = Schema.Struct({
  maxHarnessCalls: PositiveInt,
  maxDepth: PositiveInt,
  maxClarifications: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  /** How many sibling components of one division are explored at once. */
  maxConcurrency: PositiveInt,
});
export type AnalysisBounds = Schema.Schema.Type<typeof AnalysisBounds>;

export const defaultAnalysisBounds: AnalysisBounds = {
  maxHarnessCalls: 48,
  maxDepth: 7,
  maxClarifications: 3,
  maxConcurrency: 4,
};

/** Which provider/model/variant and turn budget a run's session uses —
 * the caller's choice, threaded straight through to `harness.start()`. */
export type HarnessSelection = Pick<
  HarnessSessionConfig,
  "model" | "turnTimeout" | "maxGenerationTokens"
>;

export type AnalyzeError = GitError | HarnessError;

/**
 * `exchange`'s own error channel, wider than `AnalyzeError`: reaching the
 * call budget is a control-flow signal for `visit`, its only caller, which
 * catches the tag and turns it into a gap scope. It never needs to be part
 * of `analyze()`'s public failure contract.
 */
type ExchangeError = AnalyzeError | AnalysisBoundExceededError;

/**
 * One visited scope with the subtree it opened, before ids exist. Scopes
 * are collected per subtree and numbered in one final pre-order pass, so
 * the artifact is the same whatever order concurrent siblings finish in.
 */
interface ScopeNode {
  readonly originatingComponentId: number | null;
  readonly inputPaths: ReadonlyArray<string>;
  readonly result: ScopeResult;
  readonly children: ReadonlyArray<ScopeNode>;
}

const flattenScopes = (
  node: ScopeNode,
  parentScopeId: number | null,
  out: Array<AnalysisScope>,
): void => {
  const id = out.length + 1;
  out.push({
    id,
    parentScopeId,
    originatingComponentId: node.originatingComponentId,
    inputPaths: node.inputPaths,
    result: node.result,
  });
  for (const child of node.children) {
    flattenScopes(child, id, out);
  }
};

/**
 * The deterministic leader of the interpretation process.
 *
 * This is NOT an AI agent. It is plain, predictable code that sits above the
 * harnesses: it feeds structured work to an open model session, validates
 * what comes back against the git service, and decides the next structured
 * input (continue, clarify, recurse, or conclude). All judgment lives in the
 * models; all control flow lives here.
 */
export class Hermeneut extends Context.Service<
  Hermeneut,
  {
    /**
     * Analyze the repository containing `directory`: recursive component
     * division plus line-anchored interpretations, ending in a
     * persisted-ready artifact.
     */
    analyze(
      directory: string,
      harnessSelection: HarnessSelection,
      bounds?: AnalysisBounds,
    ): Effect.Effect<AnalysisArtifact, AnalyzeError>;
  }
>()("@know-the-map/hermeneut/Hermeneut") {}

export const HermeneutLive: Layer.Layer<Hermeneut, never, Git | Harness> = Layer.effect(
  Hermeneut,
  Effect.gen(function* () {
    const git = yield* Git;
    const harness = yield* Harness;

    const analyze = Effect.fn("Hermeneut.analyze")(function* (
      directory: string,
      harnessSelection: HarnessSelection,
      bounds: AnalysisBounds = defaultAnalysisBounds,
    ): Effect.fn.Return<AnalysisArtifact, AnalyzeError> {
      const repo = yield* git.resolve(directory);
      const entries = yield* git.inventory(repo.root);
      const inventory = new Map(entries.map((entry) => [entry.path, entry]));
      const lineCounts = new Map<string, number>();
      const lineCount = (path: string): Effect.Effect<number, GitError> =>
        Effect.gen(function* () {
          const cached = lineCounts.get(path);
          if (cached !== undefined) {
            return cached;
          }
          const count = yield* git.lineCount(repo.root, path);
          lineCounts.set(path, count);
          return count;
        });

      // Plain mutable counter on purpose: the check and the increment below
      // run in one synchronous stretch, and fibers only interleave at
      // yields, so two concurrent scopes can never both pass the check on
      // the budget's last call.
      let calls = 0;
      const claimCall = Effect.fn("Hermeneut.claimCall")(function* (
        scopePaths: ReadonlyArray<string>,
      ): Effect.fn.Return<void, AnalysisBoundExceededError> {
        if (calls >= bounds.maxHarnessCalls) {
          // The caller (visit) turns this into a gap scope rather than
          // failing the run; the sessions already spent are kept.
          // TODO(ux): offer to resume analysis from the recorded gaps in
          // a follow-up run, instead of only reporting that they exist.
          return yield* new AnalysisBoundExceededError({
            message: `analysis stopped after ${bounds.maxHarnessCalls} model calls`,
          });
        }
        calls++;
        yield* Effect.logInfo(
          `analyzing a scope of ${scopePaths.length} file(s) (model call ${calls}/${bounds.maxHarnessCalls})`,
        );
      });

      const converse = Effect.fn("Hermeneut.converse")(function* (
        session: HarnessSession,
        scopePaths: ReadonlyArray<string>,
        originatingComponent: Component | null,
      ): Effect.fn.Return<LlmResponse, ExchangeError> {
        let prompt = scopePrompt(scopePaths, originatingComponent);
        let clarifications = 0;
        while (true) {
          const response = yield* session
            .send({
              prompt,
              resultSchema: LlmResponse,
            })
            .pipe(
              // The session is still open: a payload that fails the answer
              // contract is one more thing to clarify, not a dead run.
              Effect.catchTag("InvalidResultError", (error) =>
                Effect.succeed({ kind: "contract" as const, error }),
              ),
            );
          if (response.kind === "contract") {
            yield* Effect.logWarning(
              "the model's answer did not match the contract; asking it to resubmit",
            );
            if (clarifications >= bounds.maxClarifications) {
              return yield* response.error;
            }
            clarifications++;
            // The SchemaError in `cause` carries the formatted issue tree —
            // that detail, not the wrapper message, is what lets the model
            // fix the payload.
            prompt = contractClarificationPrompt(
              response.error.cause instanceof Error
                ? response.error.cause.message
                : response.error.message,
            );
            yield* claimCall(scopePaths);
            continue;
          }
          yield* Effect.logInfo(
            response.kind === "division"
              ? `found ${response.components.length} component(s) and ${response.relationships.length} relationship(s) in this scope`
              : "this scope is one module",
          );
          const issues = yield* validateResponse(response, { inventory, lineCount });
          if (issues.length === 0) {
            return response;
          }
          yield* Effect.logWarning(
            `${issues.length} claim(s) do not match the repository; asking the model to correct them (round ${clarifications + 1})`,
          );
          if (clarifications >= bounds.maxClarifications) {
            return yield* new InvalidResultError({
              message: `model failed to produce a valid result after ${clarifications} clarification round(s); unresolved: ${issues
                .map((issue) => `claim ${issue.id} (${issue.claim}): ${issue.reason}`)
                .join("; ")}`,
            });
          }
          clarifications++;
          prompt = clarificationPrompt(issues);
          yield* claimCall(scopePaths);
        }
      });

      /**
       * One scope's whole conversation in a session of its own, so no
       * scope pays for another's transcript. The first call is claimed
       * before the session opens: a scope the budget cannot cover never
       * opens one.
       */
      const exchange = Effect.fn("Hermeneut.exchange")(function* (
        scopePaths: ReadonlyArray<string>,
        originatingComponent: Component | null,
      ): Effect.fn.Return<LlmResponse, ExchangeError> {
        yield* claimCall(scopePaths);
        return yield* Effect.acquireUseRelease(
          harness.start({
            directory: repo.root,
            systemPrompt: SYSTEM_PROMPT,
            ...harnessSelection,
          }),
          (session) => converse(session, scopePaths, originatingComponent),
          (session) => session.close(),
        );
      });

      const visit = Effect.fn("Hermeneut.visit")(function* (
        scopePaths: ReadonlyArray<string>,
        depth: number,
        originatingComponent: Component | null,
      ): Effect.fn.Return<ScopeNode, AnalyzeError> {
        // The call budget has already paid for every scope explored so
        // far; running out on this one is a reason to stop here, not to
        // discard everything the run already produced. Recording a gap
        // lets the run return what it has instead of failing outright.
        const result: ScopeResult = yield* exchange(scopePaths, originatingComponent).pipe(
          Effect.catchTag("AnalysisBoundExceededError", (error) =>
            Effect.succeed({
              kind: "gap" as const,
              reason: "call_budget" as const,
              message: error.message,
            }),
          ),
        );
        const node = (children: ReadonlyArray<ScopeNode>): ScopeNode => ({
          originatingComponentId: originatingComponent?.id ?? null,
          inputPaths: scopePaths,
          result,
          children,
        });
        if (result.kind !== "division") {
          return node([]);
        }
        if (depth >= bounds.maxDepth) {
          // The division itself was already paid for and is worth keeping;
          // only its components go unexplored, each as its own gap, so the
          // "every component has an analyzed child" invariant still holds.
          return node(
            result.components.map((component) => ({
              originatingComponentId: component.id,
              inputPaths: component.files,
              result: {
                kind: "gap",
                reason: "depth_exceeded",
                message: `division at depth ${depth} would exceed the max depth of ${bounds.maxDepth}`,
              },
              children: [],
            })),
          );
        }
        // Siblings fan out; a failure in one still fails the run, as before.
        const children = yield* Effect.forEach(
          result.components,
          (component) => visit(component.files, depth + 1, component),
          { concurrency: bounds.maxConcurrency },
        );
        return node(children);
      });

      const buildFiles = Effect.fn("Hermeneut.buildFiles")(function* (
        scopes: ReadonlyArray<AnalysisScope>,
      ): Effect.fn.Return<ReadonlyArray<FileStatus>, AnalyzeError> {
        // Every path the artifact mentions: each scope's input (the root's
        // is the whole inventory) and every anchor an interpretation cites.
        const referenced = new Set<string>();
        for (const scope of scopes) {
          for (const path of scope.inputPaths) {
            referenced.add(path);
          }
          if (scope.result.kind !== "gap") {
            for (const interpretation of scope.result.interpretations) {
              for (const anchor of interpretation.anchors) {
                referenced.add(anchor.path);
              }
            }
          }
        }
        const files: Array<FileStatus> = [];
        for (const path of [...referenced].sort()) {
          const entry = inventory.get(path);
          // Defense in depth: every path reaching `referenced` comes from
          // the inventory itself or from a claim that passed schema and
          // oracle validation, so a miss here means that invariant broke
          // elsewhere — fail loudly instead of emitting a bad artifact.
          if (entry === undefined) {
            return yield* new InvalidResultError({
              message: `file "${path}" is referenced but missing from the inventory`,
            });
          }
          files.push({ path, hash: entry.hash, lineCount: yield* lineCount(path) });
        }
        return files;
      });

      const root = yield* visit([...inventory.keys()], 0, null);
      const scopes: Array<AnalysisScope> = [];
      flattenScopes(root, null, scopes);
      const generatedAt = yield* DateTime.now;
      return {
        version: 1,
        headCommit: repo.headCommit,
        generatedAt,
        files: yield* buildFiles(scopes),
        scopes,
      } satisfies AnalysisArtifact;
    });

    return Hermeneut.of({ analyze });
  }),
);
