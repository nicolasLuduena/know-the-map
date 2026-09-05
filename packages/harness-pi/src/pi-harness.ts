import { Harness, NotImplementedError } from "@know-the-map/harness";
import { Effect, Layer } from "effect";

/**
 * Pi adapter for the `Harness` interface.
 *
 * TODO: implement. Expected shape: resolve the model, create a Pi agent
 * session, register a `submit_result` tool whose wire schema mirrors the
 * exchange's result schema, prompt, and decode the submitted payload.
 */
export const PiHarnessLive: Layer.Layer<Harness> = Layer.succeed(
  Harness,
  Harness.of({
    listModels: () =>
      Effect.fail(new NotImplementedError({ message: "pi harness is not implemented" })),
    start: () => Effect.fail(new NotImplementedError({ message: "pi harness is not implemented" })),
  }),
);
