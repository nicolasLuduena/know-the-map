import { Context, Effect, Layer } from "effect";
import { NotImplementedError } from "@know-the-map/harness";

/**
 * The deterministic leader of the interpretation process.
 *
 * This is NOT an AI agent. It is plain, predictable code that sits above the
 * harnesses: it consumes the structured outputs the models submit and decides
 * the next structured inputs to feed them. All judgment lives in the models;
 * all control flow lives here.
 *
 * TODO: design the loop phases. The shape this must eventually grow into:
 * feed structured work to a harness session -> decode and validate what came
 * back -> decide the next step (continue, fork, retry, or conclude) -> repeat
 * until the process concludes. Nothing about that shape is fixed yet, so the
 * service exposes a single stub entry point.
 */
export class Hermeneut extends Context.Service<Hermeneut, {
  run(): Effect.Effect<void, NotImplementedError>;
}>()("@know-the-map/hermeneut/Hermeneut") {}

/**
 * Stub implementation. Fails loudly until the loop is designed.
 */
export const HermeneutStub: Layer.Layer<Hermeneut> = Layer.succeed(
  Hermeneut,
  Hermeneut.of({
    run: () =>
      Effect.fail(
        new NotImplementedError({ message: "hermeneut loop is not implemented" }),
      ),
  }),
);
