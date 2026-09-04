import { Harness, NotImplementedError } from "@know-the-map/harness";
import { Effect, Layer } from "effect";

/**
 * Pi adapter for the `Harness` interface.
 *
 * TODO: implement. The probe already proves the shape this must take:
 * resolve the model, create a Pi agent session, register a `submit_result`
 * tool whose wire schema mirrors the exchange's result schema, prompt, and
 * decode the submitted payload.
 *
 * Reference implementation (transplant, do not import):
 * `harness-probe/src/pi-harness.ts`
 */
export const PiHarnessLive: Layer.Layer<Harness> = Layer.succeed(
  Harness,
  Harness.of({
    listModels: () =>
      Effect.fail(new NotImplementedError({ message: "pi harness is not implemented" })),
    start: () => Effect.fail(new NotImplementedError({ message: "pi harness is not implemented" })),
  }),
);
