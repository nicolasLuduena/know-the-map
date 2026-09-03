import { Git, type GitError } from "@know-the-map/git";
import {
  Harness,
  type HarnessError,
  type HarnessSession,
  InvalidResultError,
} from "@know-the-map/harness";
import { Context, DateTime, Effect, Layer } from "effect";
import { AnalysisBoundExceededError } from "./errors.ts";
import {
  clarificationPrompt,
  contractClarificationPrompt,
  SYSTEM_PROMPT,
  scopePrompt,
} from "./prompts.ts";
import type {
  AnalysisArtifact,
  Component,
  FileStatus,
  Interpretation,
  Relationship,
} from "./schemas.ts";
import { LlmResponse } from "./schemas.ts";
import { validateResponse } from "./validation.ts";

// TODO(config): every bound below should come from the run configuration.
const MAX_HARNESS_CALLS = 48;
const MAX_DEPTH = 3;
const MAX_CLARIFICATIONS = 3;

export type AnalyzeError = GitError | HarnessError | AnalysisBoundExceededError;

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
    analyze(directory: string): Effect.Effect<AnalysisArtifact, AnalyzeError>;
  }
>()("@know-the-map/hermeneut/Hermeneut") {}

export const HermeneutLive: Layer.Layer<Hermeneut, never, Git | Harness> = Layer.effect(
  Hermeneut,
  Effect.gen(function* () {
    const git = yield* Git;
    const harness = yield* Harness;

    const analyze = Effect.fn("Hermeneut.analyze")(function* (
      directory: string,
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

      const components: Array<Component> = [];
      const relationships: Array<Relationship> = [];
      const interpretations: Array<Interpretation> = [];
      const referenced = new Set<string>();
      let calls = 0;

      const exchange = Effect.fn("Hermeneut.exchange")(function* (
        session: HarnessSession,
        scopePaths: ReadonlyArray<string>,
      ): Effect.fn.Return<LlmResponse, AnalyzeError> {
        let prompt = scopePrompt(scopePaths);
        let clarifications = 0;
        while (true) {
          if (calls >= MAX_HARNESS_CALLS) {
            // TODO(ux): before giving up, offer to continue and report the
            // cost the sessions have accumulated — tracked as an issue.
            return yield* new AnalysisBoundExceededError({
              message: `analysis stopped after ${MAX_HARNESS_CALLS} model calls`,
            });
          }
          calls++;
          yield* Effect.logInfo(
            `analyzing a scope of ${scopePaths.length} file(s) (model call ${calls}/${MAX_HARNESS_CALLS})`,
          );
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
            if (clarifications >= MAX_CLARIFICATIONS) {
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
          if (clarifications >= MAX_CLARIFICATIONS) {
            return yield* new InvalidResultError({
              message: `model failed to produce a valid result after ${clarifications} clarification round(s); unresolved: ${issues
                .map((issue) => `claim ${issue.id} (${issue.claim}): ${issue.reason}`)
                .join("; ")}`,
            });
          }
          clarifications++;
          prompt = clarificationPrompt(issues);
        }
      });

      const visit = Effect.fn("Hermeneut.visit")(function* (
        session: HarnessSession,
        scopePaths: ReadonlyArray<string>,
        depth: number,
      ): Effect.fn.Return<void, AnalyzeError> {
        for (const path of scopePaths) {
          referenced.add(path);
        }
        const response = yield* exchange(session, scopePaths);
        const recordInterpretations = (list: ReadonlyArray<Interpretation>) => {
          interpretations.push(...list);
          for (const interpretation of list) {
            for (const anchor of interpretation.anchors) {
              referenced.add(anchor.path);
            }
          }
        };
        if (response.kind === "module") {
          recordInterpretations(response.interpretations);
          return;
        }
        if (depth >= MAX_DEPTH) {
          return yield* new AnalysisBoundExceededError({
            message: `division at depth ${depth} would exceed the max depth of ${MAX_DEPTH}`,
          });
        }
        components.push(...response.components);
        relationships.push(...response.relationships);
        recordInterpretations(response.interpretations);
        for (const component of response.components) {
          yield* visit(session, component.files, depth + 1);
        }
      });

      const buildFiles = Effect.fn("Hermeneut.buildFiles")(function* (): Effect.fn.Return<
        ReadonlyArray<FileStatus>,
        AnalyzeError
      > {
        const files: Array<FileStatus> = [];
        for (const path of [...referenced].sort()) {
          const entry = inventory.get(path);
          // Defense in depth: component files and anchors are validated
          // against the inventory, but scope paths enter `referenced`
          // before any claim validation has run over them.
          if (entry === undefined) {
            return yield* new InvalidResultError({
              message: `file "${path}" is referenced but missing from the inventory`,
            });
          }
          files.push({ path, hash: entry.hash, lineCount: yield* lineCount(path) });
        }
        return files;
      });

      return yield* Effect.acquireUseRelease(
        harness.start({ directory: repo.root, systemPrompt: SYSTEM_PROMPT }),
        (session) =>
          Effect.gen(function* () {
            yield* visit(session, [...inventory.keys()], 0);
            const generatedAt = yield* DateTime.now;
            return {
              headCommit: repo.headCommit,
              generatedAt,
              components,
              relationships,
              interpretations,
              files: yield* buildFiles(),
            } satisfies AnalysisArtifact;
          }),
        (session) => session.close(),
      );
    });

    return Hermeneut.of({ analyze });
  }),
);
