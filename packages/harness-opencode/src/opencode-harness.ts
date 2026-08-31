import {
  Harness,
  type HarnessError,
  type HarnessExchange,
  type HarnessSession,
  type HarnessSessionConfig,
  HostFailureError,
  InvalidResultError,
  MissingApiKeyError,
  NoSubmissionError,
} from "@know-the-map/harness";
import { Plugin } from "@opencode-ai/plugin/effect";
import { Model, OpenCode, type Session, Tool } from "@opencode-ai/sdk/effect";
import { Deferred, Effect, Layer, Option, Ref, Schema } from "effect";
import {
  OPENCODE_CREATE_OPTIONS,
  OPENCODE_MODEL,
  resolveOpenCodeGoApiKey,
} from "./opencode-config.ts";

const SUBMIT_RESULT_DESCRIPTION =
  "Submit the structured result of the task. Call this exactly once with your final answer.";

const MAX_GENERATION_TOKENS = 32_768;

/**
 * Permissive wire schema for `submit_result`: the harness applies the real
 * contract (the exchange's `resultSchema`) after capture, so the tool itself
 * accepts any object.
 */
const SUBMIT_RESULT_INPUT = { type: "object" } as const;

interface PendingRequest {
  readonly submission: Deferred.Deferred<unknown, never>;
}

interface HostState {
  readonly session: Deferred.Deferred<Plugin.Context["session"], never>;
  readonly pending: Ref.Ref<ReadonlyMap<string, PendingRequest>>;
  /** Per-session system prompt; the slice runs one session at a time. */
  readonly systemPrompt: Ref.Ref<string>;
}

const submissionTool = (state: HostState) =>
  Plugin.define({
    id: "what-the-hunk.submit-result",
    effect: (ctx) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(state.session, ctx.session);

        yield* ctx.tool.transform((draft) => {
          draft.add({
            name: "submit_result",
            description: SUBMIT_RESULT_DESCRIPTION,
            input: SUBMIT_RESULT_INPUT,
            execute: (input, context) =>
              Effect.gen(function* () {
                const pending = (yield* Ref.get(state.pending)).get(context.sessionID);
                if (pending === undefined) {
                  return yield* new Tool.Error({
                    message: "no pending harness exchange",
                  });
                }
                yield* Deferred.succeed(pending.submission, input);
                return { content: "Result submitted." };
              }),
          });
        });

        yield* ctx.session.hook("context", (event) =>
          Effect.gen(function* () {
            event.system.push({
              type: "text",
              text: yield* Ref.get(state.systemPrompt),
            });
            event.generation.maxTokens = MAX_GENERATION_TOKENS;
            const submit = event.tools["submit_result"];
            if (submit !== undefined) {
              event.tools = { submit_result: submit };
            }
          }),
        );
      }),
  });

const sendExchange = Effect.fn("OpencodeHarnessSession.send")(function* <T, I>(
  state: HostState,
  opencode: OpenCode.Interface,
  pluginSession: Plugin.Context["session"],
  sessionID: Session.ID,
  exchange: HarnessExchange<T, I>,
): Effect.fn.Return<T, HarnessError> {
  const pending: PendingRequest = {
    submission: yield* Deferred.make<unknown, never>(),
  };

  const register = Ref.update(state.pending, (requests) => {
    const next = new Map(requests);
    next.set(sessionID, pending);
    return next;
  });
  const unregister = Ref.update(state.pending, (requests) => {
    const next = new Map(requests);
    next.delete(sessionID);
    return next;
  });

  return yield* Effect.acquireUseRelease(
    register,
    () =>
      Effect.gen(function* () {
        yield* pluginSession
          .prompt({
            sessionID,
            text: exchange.prompt,
          })
          .pipe(
            Effect.mapError(
              (cause) => new HostFailureError({ message: "sessions.prompt() failed", cause }),
            ),
          );

        yield* pluginSession
          .wait({ sessionID })
          .pipe(
            Effect.mapError(
              (cause) => new HostFailureError({ message: "sessions.wait() failed", cause }),
            ),
          );

        if (!(yield* Deferred.isDone(pending.submission))) {
          const exported = yield* opencode.sessions.export({ sessionID }).pipe(Effect.option);
          if (Option.isSome(exported)) {
            const last = exported.value.messages[exported.value.messages.length - 1];
            yield* Effect.logWarning(
              `session produced ${exported.value.messages.length} messages; last: ${
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

        return yield* Schema.decodeUnknownEffect(exchange.resultSchema)(submitted).pipe(
          Effect.mapError(
            (cause) =>
              new InvalidResultError({
                message: "submit_result payload failed validation",
                cause,
              }),
          ),
        );
      }),
    () => unregister,
  );
});

/**
 * OpenCode adapter for the `Harness` interface. Transplant of
 * `harness-probe/src/opencode2-harness.ts`: an embedded OpenCode host, a
 * session restricted to the `submit_result` tool plus read-only exploration,
 * and one validated payload per `send`.
 */
export const OpencodeHarnessLive: Layer.Layer<Harness, MissingApiKeyError | HostFailureError> =
  Layer.effect(
    Harness,
    Effect.gen(function* () {
      const apiKey = yield* resolveOpenCodeGoApiKey;
      if (apiKey === undefined) {
        return yield* new MissingApiKeyError({
          message:
            "no opencode-go API key found; log in to opencode (auth.json is the only key source)",
        });
      }

      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = process.env["OPENCODE_GO_API_KEY"];
          process.env["OPENCODE_GO_API_KEY"] = apiKey;
          return previous;
        }),
        (previous) =>
          Effect.sync(() => {
            if (previous === undefined) {
              delete process.env["OPENCODE_GO_API_KEY"];
            } else {
              process.env["OPENCODE_GO_API_KEY"] = previous;
            }
          }),
      );

      const opencode = yield* OpenCode.create(OPENCODE_CREATE_OPTIONS).pipe(
        Effect.mapError(
          (cause) => new HostFailureError({ message: "OpenCode.create() failed", cause }),
        ),
      );

      const model = Model.Ref.parse(OPENCODE_MODEL);

      const state: HostState = {
        session: yield* Deferred.make<Plugin.Context["session"], never>(),
        pending: yield* Ref.make<ReadonlyMap<string, PendingRequest>>(new Map()),
        systemPrompt: yield* Ref.make(""),
      };

      yield* opencode
        .plugin(submissionTool(state))
        .pipe(
          Effect.mapError(
            (cause) => new HostFailureError({ message: "plugin registration failed", cause }),
          ),
        );
      yield* opencode.plugin
        .list()
        .pipe(
          Effect.mapError(
            (cause) => new HostFailureError({ message: "plugin activation failed", cause }),
          ),
        );
      const pluginSession = yield* Deferred.await(state.session);

      const start = Effect.fn("Harness.start")(function* (
        config: HarnessSessionConfig,
      ): Effect.fn.Return<HarnessSession, HarnessError> {
        yield* Ref.set(state.systemPrompt, config.systemPrompt);
        const created = yield* pluginSession
          .create({
            title: "ktm analyze",
            model,
          })
          .pipe(
            Effect.mapError(
              (cause) => new HostFailureError({ message: "sessions.create() failed", cause }),
            ),
          );
        const sessionID = created.id;

        return {
          send: <T, I>(exchange: HarnessExchange<T, I>) =>
            sendExchange(state, opencode, pluginSession, sessionID, exchange),
          close: () => Effect.void,
        };
      });

      return Harness.of({ start });
    }),
  );
