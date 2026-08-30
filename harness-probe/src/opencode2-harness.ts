import {
  Config,
  Context,
  Deferred,
  Effect,
  Layer,
  Ref,
  Schema,
} from "effect";
import { Model, OpenCode, Tool } from "@opencode-ai/sdk/effect";
import { Plugin } from "@opencode-ai/plugin/effect";
import {
  OPENCODE_CREATE_OPTIONS,
  resolveOpenCodeGoApiKey,
} from "./opencode-config.ts";
import {
  EchoRequest,
  EchoResult,
  EchoResultForRequest,
  renderRequestPrompt,
} from "./schemas.ts";

const SYSTEM_PROMPT = `You are a structured echo assistant for a transport probe.

You will receive a small task as JSON. Reflect briefly on the task, then submit
your complete final answer by calling the "submit_result" tool exactly once.

The tool call arguments ARE your answer. Never write the answer as chat text;
only the submit_result call counts.`;

export class HostFailureError extends Schema.TaggedError<HostFailureError>()(
  "HostFailureError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) { }

export class MissingApiKeyError extends Schema.TaggedError<MissingApiKeyError>()(
  "MissingApiKeyError",
  { message: Schema.String },
) { }

export class NoSubmissionError extends Schema.TaggedError<NoSubmissionError>()(
  "NoSubmissionError",
  {
    message: Schema.String,
  },
) { }

export class InvalidResultError extends Schema.TaggedError<InvalidResultError>()(
  "InvalidResultError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) { }

export type Opencode2Error =
  | HostFailureError
  | MissingApiKeyError
  | NoSubmissionError
  | InvalidResultError;

export const DEFAULT_MODEL = "opencode-go/deepseek-v4-flash";

export const SupportedModel = Schema.Literals([
  DEFAULT_MODEL,
  "opencode-go/glm-5.3-flash",
]);

const SUBMIT_RESULT_DESCRIPTION =
  "Submit the structured result of the task. Call this exactly once with your final answer.";

interface PendingRequest {
  readonly submission: Deferred.Deferred<unknown, never>;
}

interface SubmissionState {
  readonly session: Deferred.Deferred<Plugin.Context["session"], never>;
  readonly pending: Ref.Ref<ReadonlyMap<string, PendingRequest>>;
}

const submissionTool = (state: SubmissionState) =>
  Plugin.define({
    id: "harness-probe.submit-result",
    effect: (ctx) =>
      Effect.gen(function*() {
        yield* Deferred.succeed(state.session, ctx.session);

        yield* ctx.tool.transform((draft) => {
          draft.add({
            name: "submit_result",
            description: SUBMIT_RESULT_DESCRIPTION,
            input: EchoResult,
            execute: (input, context) =>
              Effect.gen(function*() {
                const pending = (yield* Ref.get(state.pending)).get(context.sessionID);
                if (pending === undefined) {
                  return yield* new Tool.Error({
                    message: "no pending harness request",
                  });
                }
                yield* Deferred.succeed(pending.submission, input);
                return { content: "Result submitted." };
              }),
          });
        });

        yield* ctx.session.hook("context", (event) =>
          Effect.sync(() => {
            event.system.push({ type: "text", text: SYSTEM_PROMPT });
            event.generation.maxTokens = 2_048;
            const keep = event.tools["submit_result"];
            if (keep !== undefined) {
              event.tools = { submit_result: keep };
            }
          }));
      }),
  });

export class Opencode2Harness extends Context.Service<Opencode2Harness, {
  execute(request: EchoRequest): Effect.Effect<EchoResult, Opencode2Error>;
}>()("harness-probe/Opencode2Harness") {
  static readonly Live = Layer.effect(
    Opencode2Harness,
    Effect.gen(function*() {
      const apiKey = yield* resolveOpenCodeGoApiKey();
      if (apiKey === undefined) {
        return yield* new MissingApiKeyError({
          message:
            "no opencode-go API key found (set OPENCODE_GO_API_KEY or log in to opencode)",
        });
      }

      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = process.env.OPENCODE_GO_API_KEY;
          process.env.OPENCODE_GO_API_KEY = apiKey;
          return previous;
        }),
        (previous) =>
          Effect.sync(() => {
            if (previous === undefined) {
              delete process.env.OPENCODE_GO_API_KEY;
            } else {
              process.env.OPENCODE_GO_API_KEY = previous;
            }
          }),
      );

      yield* Effect.logInfo("Creating embedded OpenCode host");
      const opencode = yield* OpenCode.create(OPENCODE_CREATE_OPTIONS).pipe(
        Effect.mapError((cause) =>
          new HostFailureError({ message: "OpenCode.create() failed", cause }),
        ),
      );

      const modelSpec = yield* Config.schema(SupportedModel, "OC2_MODEL").pipe(
        Config.orElse(() => Config.succeed(DEFAULT_MODEL)),
      );
      const model = Model.Ref.parse(modelSpec);

      const state: SubmissionState = {
        session: yield* Deferred.make<Plugin.Context["session"], never>(),
        pending: yield* Ref.make<ReadonlyMap<string, PendingRequest>>(new Map()),
      };

      yield* opencode.plugin(submissionTool(state)).pipe(
        Effect.mapError((cause) =>
          new HostFailureError({ message: "plugin registration failed", cause }),
        ),
      );
      yield* opencode.plugin.list().pipe(
        Effect.mapError((cause) =>
          new HostFailureError({ message: "plugin activation failed", cause }),
        ),
      );
      const pluginSession = yield* Deferred.await(state.session);

      const execute = Effect.fn("Opencode2Harness.execute")(function*(
        request: EchoRequest,
      ): Effect.fn.Return<EchoResult, Opencode2Error> {
        yield* Effect.logInfo(`Using model: ${model.providerID}/${model.id}`);

        yield* Effect.logInfo("Creating session");
        const session = yield* pluginSession.create({
          title: "harness-probe echo",
          model,
        }).pipe(
          Effect.mapError((cause) =>
            new HostFailureError({ message: "sessions.create() failed", cause }),
          ),
        );

        const pending: PendingRequest = {
          submission: yield* Deferred.make<unknown, never>(),
        };

        const register = Ref.update(state.pending, (requests) => {
          const next = new Map(requests);
          next.set(session.id, pending);
          return next;
        });
        const unregister = Ref.update(state.pending, (requests) => {
          const next = new Map(requests);
          next.delete(session.id);
          return next;
        });

        return yield* Effect.acquireUseRelease(
          register,
          () =>
            Effect.gen(function*() {
              yield* Effect.logInfo("Sending structured request");
              yield* pluginSession.prompt({
                sessionID: session.id,
                text: renderRequestPrompt(request),
              }).pipe(
                Effect.mapError((cause) =>
                  new HostFailureError({ message: "sessions.prompt() failed", cause }),
                ),
              );

              yield* pluginSession.wait({ sessionID: session.id }).pipe(
                Effect.mapError((cause) =>
                  new HostFailureError({ message: "sessions.wait() failed", cause }),
                ),
              );

              if (!(yield* Deferred.isDone(pending.submission))) {
                const exported = yield* opencode.sessions.export({ sessionID: session.id }).pipe(
                  Effect.catch(() => Effect.succeed(undefined)),
                );
                if (exported !== undefined) {
                  const last = exported.messages[exported.messages.length - 1];
                  yield* Effect.logWarning(
                    `session produced ${exported.messages.length} messages; last: ${
                      last === undefined ? "(none)" : JSON.stringify(last).slice(0, 500)
                    }`,
                  );
                  if (last?.type === "assistant" && last.finish === "error") {
                    return yield* new HostFailureError({
                      message: "session execution failed",
                      cause: last.error,
                    });
                  }
                }
                return yield* new NoSubmissionError({
                  message: "agent finished without calling submit_result",
                });
              }

              const submitted = yield* Deferred.await(pending.submission);

              yield* Effect.logInfo("Validating submitted result");
              const result = yield* Schema.decodeUnknownEffect(
                EchoResultForRequest(request),
              )(submitted).pipe(
                Effect.mapError((cause) =>
                  new InvalidResultError({
                    message: "submit_result payload failed validation",
                    cause,
                  }),
                ),
              );

              yield* Effect.logInfo("Structured result received");
              return result;
            }),
          () => unregister,
        );
      });

      return Opencode2Harness.of({ execute });
    }),
  );
}
