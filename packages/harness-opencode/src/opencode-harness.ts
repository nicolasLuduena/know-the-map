import {
  guard,
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
import {
  Location,
  Model,
  OpenCode,
  type Session,
  type SessionMessage,
  Tool,
} from "@opencode-ai/sdk/effect";
import { type Config, Deferred, Duration, Effect, Layer, Option, Ref, Schema } from "effect";
import {
  buildCreateOptions,
  defaultOpencodeHarnessConfig,
  loadOpencodeHarnessConfig,
  type OpencodeHarnessConfig,
  resolveOpenCodeGoApiKey,
} from "./opencode-config.ts";

const SUBMIT_RESULT_DESCRIPTION =
  "Submit the structured result of the task. Call this exactly once with your final answer.";

/**
 * Tools the analyze session must never see: anything that could mutate the
 * repository, prompt a human, or spawn work we cannot await. On top of this
 * filter, the host config denies the corresponding permissions, so mutation
 * is doubly blocked. Exploration aids that are read-only (skill, websearch)
 * stay available.
 */
const BLOCKED_TOOLS = new Set([
  "bash",
  "edit",
  "write",
  "patch",
  "webfetch",
  "todowrite",
  "todoread",
  "question",
  "task",
]);

/**
 * Mutable wiring between the layer and the plugin, shared because the SDK
 * only exposes the host's session domain from inside plugin context:
 *
 * - `session`: resolved once, when the plugin boots — the host session
 *   domain (`create`/`prompt`/`wait`) as seen from the plugin side.
 * - `pending`: in-flight exchanges keyed by session id. Each entry is the
 *   one-shot Deferred waiting for that session's `submit_result` payload.
 * - `systemPrompt`: what the context hook appends to every generation. The
 *   slice runs one session at a time, so a single Ref suffices.
 */
interface HostState {
  readonly session: Deferred.Deferred<Plugin.Context["session"], never>;
  readonly pending: Ref.Ref<ReadonlyMap<string, Deferred.Deferred<unknown, never>>>;
  readonly systemPrompt: Ref.Ref<string>;
}

const submissionTool = (state: HostState, config: OpencodeHarnessConfig) =>
  Plugin.define({
    id: "what-the-hunk.submit-result",
    effect: (ctx) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(state.session, ctx.session);

        // `draft` is ToolDraft: the plugin-facing tool registry. The input
        // schema is intentionally permissive — the real contract is the
        // exchange's resultSchema, applied by the harness after capture —
        // so a malformed payload gets a typed InvalidResultError (and a
        // clarification round) instead of an opaque tool-schema rejection.
        yield* ctx.tool.transform((draft) => {
          draft.add({
            name: "submit_result",
            description: SUBMIT_RESULT_DESCRIPTION,
            input: { type: "object" } as const,
            execute: (input, context) =>
              Effect.gen(function* () {
                const submission = yield* Ref.get(state.pending).pipe(
                  Effect.map((requests) => requests.get(context.sessionID)),
                  Effect.filterOrFail(
                    (request) => request !== undefined,
                    () =>
                      new Tool.Error({
                        message: "no pending harness exchange for this session",
                      }),
                  ),
                );
                yield* Deferred.succeed(submission, input);
                return { content: "Result submitted." };
              }),
          });
        });

        // Runs on every generation, just before the model call: append the
        // fixed instructions, cap output tokens, and strip blocked tools.
        // `event.system.push` adds to the agent's own system prompt (Plan /
        // Build behavior included) — it does not replace it.
        yield* ctx.session.hook("context", (event) =>
          Effect.gen(function* () {
            event.system.push({
              type: "text",
              text: yield* Ref.get(state.systemPrompt),
            });
            event.generation.maxTokens = config.maxGenerationTokens;
            event.tools = Object.fromEntries(
              Object.entries(event.tools).filter(([name]) => !BLOCKED_TOOLS.has(name)),
            );
            yield* Effect.logInfo(`analyze session tools: ${Object.keys(event.tools).join(", ")}`);
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
  turnTimeout: Duration.Duration,
): Effect.fn.Return<T, HarnessError> {
  const submission = yield* Deferred.make<unknown, never>();

  const register = Ref.update(state.pending, (requests) =>
    new Map(requests).set(sessionID, submission),
  );
  const unregister = Ref.update(state.pending, (requests) => {
    const next = new Map(requests);
    next.delete(sessionID);
    return next;
  });

  // Interruption-safe bookkeeping: the exchange owns its slot for exactly
  // the turn — registered before, unregistered however the turn ends.
  return yield* Effect.acquireUseRelease(
    register,
    () =>
      Effect.gen(function* () {
        // One turn = prompt + wait for idle. `wait` blocks until the
        // session has finished all generations and tool calls it queued
        // for the prompt, not just until the first reply part.
        yield* pluginSession.prompt({ sessionID, text: exchange.prompt }).pipe(
          Effect.mapError(
            (cause) => new HostFailureError({ message: "sessions.prompt() failed", cause }),
          ),
          Effect.timeoutOrElse({
            duration: turnTimeout,
            orElse: () =>
              Effect.fail(
                new HostFailureError({
                  message: `sessions.prompt() exceeded the ${Duration.format(turnTimeout)} turn budget`,
                }),
              ),
          }),
        );

        yield* pluginSession.wait({ sessionID }).pipe(
          Effect.mapError(
            (cause) => new HostFailureError({ message: "sessions.wait() failed", cause }),
          ),
          Effect.timeoutOrElse({
            duration: turnTimeout,
            orElse: () =>
              Effect.fail(
                new HostFailureError({
                  message: `sessions.wait() exceeded the ${Duration.format(turnTimeout)} turn budget`,
                }),
              ),
          }),
        );

        const submitted = yield* Deferred.isDone(submission);
        if (!submitted) {
          // The turn ended with no tool call. Pull the transcript to tell
          // "the session errored" apart from "the model answered in chat
          // instead of submitting". `Effect.option` absorbs a missing or
          // gone session: nothing to report, plain NoSubmissionError.
          const exported = yield* opencode.sessions.export({ sessionID }).pipe(Effect.option);
          if (Option.isSome(exported)) {
            const last: SessionMessage.Info | undefined =
              exported.value.messages[exported.value.messages.length - 1];
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

        const payload = yield* Deferred.await(submission);

        return yield* Schema.decodeUnknownEffect(exchange.resultSchema)(payload).pipe(
          Effect.tapErrorTag("SchemaError", () =>
            Effect.logWarning(
              `submit_result payload failed validation: ${JSON.stringify(payload).slice(0, 2000)}`,
            ),
          ),
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
export const layerFromConfig = (
  config: OpencodeHarnessConfig,
): Layer.Layer<Harness, MissingApiKeyError | HostFailureError> =>
  Layer.effect(
    Harness,
    Effect.gen(function* () {
      // MCP servers are plumbed but not yet supported: an enabled server
      // can mutate and reach the network under tool names we can't
      // predict, so it needs per-server permission policy that doesn't
      // exist yet — a populated map here would otherwise silently boot a
      // host that hangs on the first MCP tool call (unmatched actions
      // fall back to "ask", fatal for a headless run).
      yield* guard(
        Object.keys(config.mcpServers).length === 0,
        () =>
          new HostFailureError({
            message:
              "MCP servers are not yet supported: enabling any server needs per-server permission rules that don't exist yet (see issue #27)",
          }),
      );

      // The provider/model catalog itself is fixed (see opencode-config.ts);
      // `config.model` only selects which entry of that catalog boots.
      // Guarded here, before any I/O, rather than let an unmatched model
      // surface later inside `pluginSession.create()`.
      yield* guard(
        config.model === defaultOpencodeHarnessConfig.model,
        () =>
          new HostFailureError({
            message: `unknown model "${config.model}": the opencode-go catalog only serves "${defaultOpencodeHarnessConfig.model}"`,
          }),
      );

      const apiKey = yield* resolveOpenCodeGoApiKey.pipe(
        Effect.filterOrFail(
          (key) => key !== undefined,
          () =>
            new MissingApiKeyError({
              message:
                "no opencode-go API key found; log in to opencode (auth.json is the only key source)",
            }),
        ),
      );

      // The provider reads its key from the env var declared in the host
      // config (`env: ["OPENCODE_GO_API_KEY"]`). This is a permanent
      // constraint, not a deferred TODO: the embedded host's own
      // `ServerOptions` (checked against @opencode-ai/server's types)
      // exposes no key parameter at all, and its credential API only
      // renames or removes *stored* credentials. So we inject the
      // variable for exactly the lifetime of the host and restore the
      // previous value after — keeping the key out of any config file
      // written to disk. Revisit only if the SDK ever grows a scoped key
      // parameter.
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

      const opencode = yield* OpenCode.create(buildCreateOptions(config)).pipe(
        Effect.mapError(
          (cause) => new HostFailureError({ message: "OpenCode.create() failed", cause }),
        ),
      );

      const model = Model.Ref.parse(config.model);

      const state: HostState = {
        session: yield* Deferred.make<Plugin.Context["session"], never>(),
        pending: yield* Ref.make<ReadonlyMap<string, Deferred.Deferred<unknown, never>>>(new Map()),
        systemPrompt: yield* Ref.make(""),
      };

      yield* opencode
        .plugin(submissionTool(state, config))
        .pipe(
          Effect.mapError(
            (cause) => new HostFailureError({ message: "plugin registration failed", cause }),
          ),
        );
      // Plugin booting is lazy: `list()` is what makes the host instantiate
      // the registration, whose effect resolves `state.session`. The only
      // plugin we register is `submit_result` itself; we rely on no other
      // plugin behavior.
      yield* opencode.plugin
        .list()
        .pipe(
          Effect.mapError(
            (cause) => new HostFailureError({ message: "plugin activation failed", cause }),
          ),
        );
      const pluginSession = yield* Deferred.await(state.session);

      const start = Effect.fn("Harness.start")(function* (
        sessionConfig: HarnessSessionConfig,
      ): Effect.fn.Return<HarnessSession, HarnessError> {
        yield* Ref.set(state.systemPrompt, sessionConfig.systemPrompt);
        const created = yield* pluginSession
          .create({
            title: "ktm analyze",
            model,
            // The session's working directory: file tools of the analyze
            // agent are scoped to the repository under analysis, not to
            // wherever the host process happens to run.
            location: { directory: Location.Ref.fields.directory.make(sessionConfig.directory) },
          })
          .pipe(
            Effect.mapError(
              (cause) => new HostFailureError({ message: "sessions.create() failed", cause }),
            ),
          );

        return {
          send: <T, I>(exchange: HarnessExchange<T, I>) =>
            sendExchange(state, opencode, pluginSession, created.id, exchange, config.turnTimeout),
          close: () => Effect.void,
        };
      });

      return Harness.of({ start });
    }),
  );

/**
 * Env-var-driven default: resolves `OpencodeHarnessConfig` once, at layer
 * construction, then builds the harness from it. See
 * `loadOpencodeHarnessConfig` for the env vars and defaults.
 */
export const OpencodeHarnessLive: Layer.Layer<
  Harness,
  Config.ConfigError | MissingApiKeyError | HostFailureError
> = Layer.unwrap(loadOpencodeHarnessConfig.pipe(Effect.map(layerFromConfig)));
