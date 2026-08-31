import { Context, Effect, Layer, type Schema } from "effect";
import {
  type HostFailureError,
  type InvalidResultError,
  type MissingApiKeyError,
  type NoSubmissionError,
  NotImplementedError,
} from "./errors.ts";

export interface HarnessSessionConfig {
  /** Fixed instruction block applied to every exchange of the session. */
  readonly systemPrompt: string;
}

export interface HarnessExchange<T, I> {
  /** The turn's user prompt (task, scope, or clarification). */
  readonly prompt: string;
  /**
   * The contract the model's `submit_result` payload must satisfy. The
   * harness decodes against it before handing the value back.
   */
  readonly resultSchema: Schema.Codec<T, I, never, never>;
}

/**
 * One open model conversation. Sessions stay open until the hermeneut
 * decides to close them: clarification rounds reuse the same session so the
 * model keeps the context of what it claimed.
 */
export interface HarnessSession {
  send<T, I>(exchange: HarnessExchange<T, I>): Effect.Effect<T, HarnessError>;
  close(): Effect.Effect<void, HarnessError>;
}

/**
 * A replaceable execution harness. Know the Map owns orchestration, schemas
 * and validation; the harness owns each bounded model conversation, its
 * tools, provider selection and streaming.
 */
export class Harness extends Context.Service<
  Harness,
  {
    start(config: HarnessSessionConfig): Effect.Effect<HarnessSession, HarnessError>;
  }
>()("@know-the-map/harness/Harness") {}

/**
 * `NotImplementedError` is raised only by stubs; real adapters never do.
 */
export type HarnessError =
  | NotImplementedError
  | HostFailureError
  | MissingApiKeyError
  | NoSubmissionError
  | InvalidResultError;

/**
 * A `Harness` implementation that always fails. Useful for wiring and tests
 * until a real adapter lands.
 */
export const HarnessStub: Layer.Layer<Harness> = Layer.succeed(
  Harness,
  Harness.of({
    start: () => Effect.fail(new NotImplementedError({ message: "harness is not implemented" })),
  }),
);
