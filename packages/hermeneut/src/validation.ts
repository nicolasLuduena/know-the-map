import type { GitError, InventoryEntry } from "@know-the-map/git";
import { Effect } from "effect";
import type { Anchor, Interpretation, LlmResponse } from "./schemas.ts";

export interface ClaimIssue {
  readonly id: number;
  /** Human-readable description of the claim, e.g. "component". */
  readonly claim: string;
  readonly reason: string;
}

export interface ValidationContext {
  readonly inventory: ReadonlyMap<string, InventoryEntry>;
  readonly lineCount: (path: string) => Effect.Effect<number, GitError>;
}

const checkAnchor = Effect.fn("hermeneut.checkAnchor")(function* (
  anchor: Anchor,
  claimId: number,
  ctx: ValidationContext,
  issues: Array<ClaimIssue>,
) {
  const entry = ctx.inventory.get(anchor.path);
  if (entry === undefined) {
    issues.push({
      id: claimId,
      claim: "interpretation",
      reason: `unknown file "${anchor.path}"`,
    });
    return;
  }
  const count = yield* ctx.lineCount(anchor.path);
  if (anchor.lineEnd > count) {
    issues.push({
      id: claimId,
      claim: "interpretation",
      reason: `anchor on "${anchor.path}" ends at line ${anchor.lineEnd} but the file has ${count} lines`,
    });
  }
});

/**
 * The anti-hallucination gate. The Schema already rejected malformed
 * shapes (ids, kinds, ranges, dangling endpoints); this checks what only
 * the repository can answer: claimed files must exist in the inventory and
 * anchors must fit the file's line count. Failures become clarification
 * issues keyed by the model-assigned claim id.
 */
export const validateResponse = Effect.fn("hermeneut.validateResponse")(function* (
  response: LlmResponse,
  ctx: ValidationContext,
): Effect.fn.Return<ReadonlyArray<ClaimIssue>, GitError> {
  const issues: Array<ClaimIssue> = [];

  if (response.kind === "division") {
    for (const component of response.components) {
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
  }

  const interpretations: ReadonlyArray<Interpretation> = response.interpretations;
  for (const interpretation of interpretations) {
    for (const anchor of interpretation.anchors) {
      yield* checkAnchor(anchor, interpretation.id, ctx, issues);
    }
  }

  return issues;
});
