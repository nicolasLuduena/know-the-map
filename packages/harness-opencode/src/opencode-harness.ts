import { Effect, Layer } from "effect";
import {
  Harness,
  HarnessRequest,
  HarnessResult,
  NotImplementedError,
} from "@know-the-map/harness";

/**
 * OpenCode adapter for the `Harness` interface.
 *
 * TODO: implement. The probe already proves the shape this must take:
 * activate an in-process plugin, restrict the session to a single
 * `submit_result` tool whose parameters mirror the result schema, wait for
 * the session to finish, and decode the submitted payload.
 *
 * Reference implementation (transplant, do not import):
 * `harness-probe/src/opencode2-harness.ts`
 */
export const OpencodeHarnessLive: Layer.Layer<Harness> = Layer.succeed(
  Harness,
  Harness.of({
    execute: (_request: HarnessRequest): Effect.Effect<HarnessResult, NotImplementedError> =>
      Effect.fail(
        new NotImplementedError({ message: "opencode harness is not implemented" }),
      ),
  }),
);
