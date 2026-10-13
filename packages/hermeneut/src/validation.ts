import type { GitError, InventoryEntry } from "@know-the-map/git";
import { Effect } from "effect";
import type { Anchor, Interpretation, LlmResponse } from "./schemas.ts";

export interface ClaimIssue {
  /** Model-assigned claim id; null when the whole answer is the claim (a gap). */
  readonly id: number | null;
  /** Human-readable description of the claim, e.g. "component". */
  readonly claim: string;
  readonly reason: string;
}

/** One issue as the model (and the failure message) should read it. */
export const describeIssue = (issue: ClaimIssue): string =>
  issue.id === null
    ? `${issue.claim}: ${issue.reason}`
    : `claim ${issue.id} (${issue.claim}): ${issue.reason}`;

export interface ValidationContext {
  /** The files of the analyzed scope: what the model was given. */
  readonly inventory: ReadonlyMap<string, InventoryEntry>;
  /** Every path in the checkout, scope or not: what a source hint may name. */
  readonly checkout: ReadonlySet<string>;
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
 * the repository can answer: claimed files must exist in the inventory,
 * anchors must fit the file's line count, and a source hint must exist
 * somewhere in the checkout. Failures become clarification issues keyed by
 * the model-assigned claim id.
 */
export const validateResponse = Effect.fn("hermeneut.validateResponse")(function* (
  response: LlmResponse,
  ctx: ValidationContext,
): Effect.fn.Return<ReadonlyArray<ClaimIssue>, GitError> {
  const issues: Array<ClaimIssue> = [];

  if (response.kind === "gap") {
    // The hint points outside the scope by design, so the whole checkout,
    // not the scope inventory, decides whether it names a real file.
    if (response.sourceHint !== undefined && !ctx.checkout.has(response.sourceHint)) {
      issues.push({
        id: null,
        claim: "opaque_source",
        reason: `sourceHint "${response.sourceHint}" is not a file in the repository; name the real source or omit the hint`,
      });
    }
    return issues;
  }

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
