import { Context, type Duration, Effect, Layer, type Schema } from "effect";
import {
  type HostFailureError,
  type InvalidResultError,
  type MissingApiKeyError,
  type NoSubmissionError,
  NotImplementedError,
} from "./errors.ts";

/** One provider+model+variant a caller has selected for a session. */
export interface HarnessModelSelection {
  readonly providerId: string;
  readonly modelId: string;
  readonly variantId?: string;
}

/**
 * One provider+model `listModels()` may offer. Already filtered to what
 * this harness can actually run — every option here is usable.
 */
export interface HarnessModelOption {
  readonly providerId: string;
  readonly modelId: string;
  readonly modelName: string;
  /** Reasoning/configuration variant ids this model offers, if any. */
  readonly variants: ReadonlyArray<string>;
  readonly limit: {
    readonly context: number;
    readonly output: number;
    readonly input?: number;
  };
  readonly cost?: ReadonlyArray<{ readonly input: number; readonly output: number }>;
}

export interface HarnessSessionConfig {
  /** Absolute path of the repository the session is pointed at. */
  readonly directory: string;
  /** Fixed instruction block applied to every exchange of the session. */
  readonly systemPrompt: string;
  /** Which provider/model/variant this session runs against. */
  readonly model: HarnessModelSelection;
  /** Budget for one model turn (prompt + wait) before it fails loudly. */
  readonly turnTimeout: Duration.Duration;
  /** Per-generation output token cap. */
  readonly maxGenerationTokens: number;
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
    /** Every provider+model this harness can actually run, right now. */
    listModels(): Effect.Effect<ReadonlyArray<HarnessModelOption>, HarnessError>;
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
    listModels: () =>
      Effect.fail(new NotImplementedError({ message: "harness is not implemented" })),
    start: () => Effect.fail(new NotImplementedError({ message: "harness is not implemented" })),
  }),
);
