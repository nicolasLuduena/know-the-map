import { Context, Effect, Layer } from "effect";
import { NotImplementedError } from "./errors.ts";
import type { HarnessRequest, HarnessResult } from "./protocol.ts";

/**
 * A replaceable execution harness. Know the Map owns orchestration, schemas
 * and validation; the harness owns each bounded model session, its tools,
 * provider selection and streaming.
 *
 * One-shot for now: one structured request in, one validated structured
 * result out. TODO: decide later whether multi-turn sessions belong in this
 * interface or in a separate one.
 */
export class Harness extends Context.Service<
  Harness,
  {
    execute(request: HarnessRequest): Effect.Effect<HarnessResult, HarnessError>;
  }
>()("@know-the-map/harness/Harness") {}

/**
 * TODO: grow this union as real failure modes are designed (transport
 * failures, no-submission, invalid-result, ...). See the probe's error
 * taxonomies in `harness-probe/src/pi-harness.ts` and
 * `harness-probe/src/opencode2-harness.ts`.
 */
export type HarnessError = NotImplementedError;

/**
 * A `Harness` implementation that always fails. Useful for wiring and tests
 * until a real adapter lands.
 */
export const HarnessStub: Layer.Layer<Harness> = Layer.succeed(
  Harness,
  Harness.of({
    execute: () => Effect.fail(new NotImplementedError({ message: "harness is not implemented" })),
  }),
);
