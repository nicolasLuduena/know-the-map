import type { GitError, InventoryEntry } from "@know-the-map/git";
import { Effect } from "effect";
import type { Anchor, InterpretationKind, LlmResponse } from "./schemas.ts";

export interface ClaimIssue {
  readonly id: number;
  /** Human-readable description of the claim, e.g. "component". */
  readonly claim: string;
  readonly reason: string;
}

export interface ValidationContext {
  readonly inventory: ReadonlyMap<string, InventoryEntry>;
  readonly lineCount: (path: string) => Effect.Effect<number, GitError>;
  /** Ids accepted in earlier exchanges of this run. */
  readonly seenIds: ReadonlySet<number>;
}

const checkAnchor = Effect.fn("hermeneut.checkAnchor")(function* (
  anchor: Anchor,
  claimId: number,
  claim: string,
  ctx: ValidationContext,
  issues: Array<ClaimIssue>,
) {
  const push = (reason: string) => {
    issues.push({ id: claimId, claim, reason });
  };
  const entry = ctx.inventory.get(anchor.path);
  if (entry === undefined) {
    push(`unknown file "${anchor.path}"`);
    return;
  }
  if (anchor.lineStart > anchor.lineEnd) {
    push(
      `anchor on "${anchor.path}" has lineStart ${anchor.lineStart} after lineEnd ${anchor.lineEnd}`,
    );
    return;
  }
  const count = yield* ctx.lineCount(anchor.path);
  if (anchor.lineEnd > count) {
    push(
      `anchor on "${anchor.path}" ends at line ${anchor.lineEnd} but the file has ${count} lines`,
    );
  }
});

/**
 * The anti-hallucination gate. Every claim the model makes is checked
 * against what the git service reports: file existence, line ranges, and
 * referential integrity of relationships. Failures become clarification
 * issues keyed by the model-assigned claim id.
 */
export const validateResponse = Effect.fn("hermeneut.validateResponse")(function* (
  response: LlmResponse,
  ctx: ValidationContext,
): Effect.fn.Return<ReadonlyArray<ClaimIssue>, GitError> {
  const issues: Array<ClaimIssue> = [];
  const localIds = new Set<number>();

  const checkId = (id: number, claim: string) => {
    if (ctx.seenIds.has(id) || localIds.has(id)) {
      issues.push({ id, claim, reason: `id ${id} is not unique` });
    }
    localIds.add(id);
  };

  const checkInterpretations = Effect.fn("hermeneut.checkInterpretations")(function* (
    interpretations: ReadonlyArray<{
      readonly id: number;
      readonly kind: InterpretationKind;
      readonly customKind?: string | undefined;
      readonly anchors: ReadonlyArray<Anchor>;
    }>,
  ) {
    for (const interpretation of interpretations) {
      checkId(interpretation.id, "interpretation");
      if (interpretation.kind === "other" && interpretation.customKind === undefined) {
        issues.push({
          id: interpretation.id,
          claim: "interpretation",
          reason: `kind "other" requires a customKind`,
        });
      }
      if (interpretation.kind !== "other" && interpretation.customKind !== undefined) {
        issues.push({
          id: interpretation.id,
          claim: "interpretation",
          reason: `customKind is only allowed when kind is "other"`,
        });
      }
      for (const anchor of interpretation.anchors) {
        yield* checkAnchor(anchor, interpretation.id, "interpretation", ctx, issues);
      }
    }
  });

  if (response.kind === "cohesive") {
    yield* checkInterpretations(response.interpretations);
    return issues;
  }

  const names = new Set<string>();
  for (const component of response.components) {
    checkId(component.id, "component");
    if (names.has(component.name)) {
      issues.push({
        id: component.id,
        claim: "component",
        reason: `duplicate component name "${component.name}"`,
      });
    }
    names.add(component.name);
    if (component.files.length === 0) {
      issues.push({
        id: component.id,
        claim: "component",
        reason: `component "${component.name}" lists no files`,
      });
    }
    for (const path of component.files) {
      if (!ctx.inventory.has(path)) {
        issues.push({
          id: component.id,
          claim: "component",
          reason: `unknown file "${path}"`,
        });
      }
    }
  }
  if (response.components.length === 0) {
    issues.push({ id: 0, claim: "division", reason: "division contains no components" });
  }
  for (const relationship of response.relationships) {
    checkId(relationship.id, "relationship");
    for (const endpoint of [relationship.from, relationship.to]) {
      if (!names.has(endpoint)) {
        issues.push({
          id: relationship.id,
          claim: "relationship",
          reason: `endpoint "${endpoint}" is not a component in this response`,
        });
      }
    }
  }
  yield* checkInterpretations(response.interpretations);
  return issues;
});
