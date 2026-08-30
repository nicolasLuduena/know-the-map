import { join } from "node:path";
import { Context, Effect, Layer, Option, Schema, Scope } from "effect";
import type { AssistantMessage, TextContent, ToolCall } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  createAgentSession,
  defineTool,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
  EchoRequest,
  EchoResult,
  EchoResultForRequest,
  EchoResultWire,
  renderRequestPrompt,
} from "./schemas.ts";

const SYSTEM_PROMPT = `You are a structured echo assistant for a transport probe.

You will receive a small task as JSON. Reflect briefly on the task, then submit
your complete final answer by calling the "submit_result" tool exactly once.

The tool call arguments ARE your answer. Never write the answer as chat text;
only the submit_result call counts.`;

export class SessionFailureError extends Schema.TaggedError<SessionFailureError>()(
  "SessionFailureError",
  {
    message: Schema.String,
    cause: Schema.Unknown,
  },
) { }

export class ModelNotFoundError extends Schema.TaggedError<ModelNotFoundError>()(
  "ModelNotFoundError",
  {
    provider: Schema.String,
    modelId: Schema.String,
  },
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
    cause: Schema.Unknown,
  },
) { }

export type PiError =
  | SessionFailureError
  | ModelNotFoundError
  | NoSubmissionError
  | InvalidResultError;

export const DEFAULT_MODEL = "opencode-go/glm-5.3-flash";

const OPENCODE_GO_AUTH_PATH = join(
  process.env.HOME ?? "",
  ".local/share/opencode/auth.json",
);

const OpenCodeGoAuth = Schema.Struct({ key: Schema.String });

const OpenCodeGoAuthFile = Schema.Struct({
  "opencode-go": Schema.optional(OpenCodeGoAuth),
});

const resolveOpenCodeGoApiKey = Effect.fn("resolveOpenCodeGoApiKey")(
  function*(): Effect.fn.Return<string | undefined> {
    const fromEnv = process.env.OPENCODE_GO_API_KEY;
    if (fromEnv !== undefined) return fromEnv;
    return yield* Effect.tryPromise(() => Bun.file(OPENCODE_GO_AUTH_PATH).json()).pipe(
      Effect.map((auth) => Schema.decodeUnknownOption(OpenCodeGoAuthFile)(auth)),
      Effect.map(Option.map((auth) => auth["opencode-go"]?.key)),
      Effect.map(Option.getOrUndefined),
      Effect.catch(() => Effect.succeed(undefined)),
    );
  },
);

const OPENCODE_GO_PROVIDER: Parameters<ModelRuntime["registerProvider"]>[1] = {
  name: "OpenCode Go",
  api: "openai-completions",
  baseUrl: "https://opencode.ai/zen/go/v1",
  models: [
    {
      id: "opencode-go/glm-5.3-flash",
      name: "GLM 5.3 Flash",
      reasoning: true,
      input: ["text"],
      thinkingLevelMap: {
        minimal: null,
        low: "low",
        medium: null,
        high: "high",
        max: "max",
      },
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      cost: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        maxTokensField: "max_tokens",
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: "zai",
      },
    },
  ],
};

const resolveModel = (spec: string): { provider: string; modelId: string } => {
  const slash = spec.indexOf("/");
  if (slash < 0) {
    return { provider: "openrouter", modelId: spec };
  }
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
};

export class PiHarness extends Context.Service<PiHarness, {
  execute(request: EchoRequest): Effect.Effect<EchoResult, PiError, Scope.Scope>;
}>()("harness-probe/PiHarness") {
  static readonly Live = Layer.effect(
    PiHarness,
    Effect.gen(function*() {
      const execute = Effect.fn("PiHarness.execute")(function*(
        request: EchoRequest,
      ): Effect.fn.Return<EchoResult, PiError, Scope.Scope> {
        yield* Effect.logInfo("Creating Pi model runtime");
        const modelRuntime = yield* Effect.tryPromise({
          try: () => ModelRuntime.create(),
          catch: (cause) =>
            new SessionFailureError({ message: "ModelRuntime.create() failed", cause }),
        });

        const { provider, modelId } = resolveModel(
          process.env.PI_MODEL ?? DEFAULT_MODEL,
        );
        if (provider === "opencode-go") {
          const apiKey = yield* resolveOpenCodeGoApiKey();
          if (apiKey === undefined) {
            return yield* new SessionFailureError({
              message:
                "no opencode-go API key found (set OPENCODE_GO_API_KEY or log in to opencode)",
              cause: undefined,
            });
          }
          modelRuntime.registerProvider("opencode-go", {
            ...OPENCODE_GO_PROVIDER,
            apiKey,
          });
        }
        const model = modelRuntime.getModel(provider, modelId);
        if (!model) {
          return yield* new ModelNotFoundError({ provider, modelId });
        }
        yield* Effect.logInfo(`Using model: ${provider}/${modelId}`);

        const loader = new DefaultResourceLoader({
          cwd: process.cwd(),
          agentDir: getAgentDir(),
          systemPromptOverride: () => SYSTEM_PROMPT,
          skillsOverride: () => ({ skills: [], diagnostics: [] }),
          promptsOverride: () => ({ prompts: [], diagnostics: [] }),
          agentsFilesOverride: () => ({ agentsFiles: [] }),
        });
        yield* Effect.tryPromise({
          try: () => loader.reload(),
          catch: (cause) =>
            new SessionFailureError({ message: "resource loader reload failed", cause }),
        });

        let submitted: unknown;
        const submitResultTool = defineTool({
          name: "submit_result",
          label: "Submit Result",
          description:
            "Submit the structured result of the task. Call this exactly once with your final answer.",
          promptGuidelines: [
            "Always call submit_result exactly once with your complete final answer.",
            "Fill in every field.",
            'echoedTopic must repeat the task "topic" value verbatim.',
          ],
          parameters: EchoResultWire,
          execute: async (_toolCallId, params) => {
            submitted = params;
            return {
              content: [{ type: "text", text: "Result submitted." }],
              details: {},
            };
          },
        });

        yield* Effect.logInfo("Creating agent session");
        const session = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              createAgentSession({
                cwd: process.cwd(),
                agentDir: getAgentDir(),
                modelRuntime,
                model,
                resourceLoader: loader,
                sessionManager: SessionManager.inMemory(),
                tools: ["submit_result"],
                customTools: [submitResultTool],
              }),
            catch: (cause) =>
              new SessionFailureError({ message: "createAgentSession() failed", cause }),
          }).pipe(Effect.map(({ session }) => session)),
          (session) =>
            Effect.tryPromise(() => session.abort()).pipe(
              Effect.ignore,
              Effect.andThen(Effect.sync(() => session.dispose())),
            ),
        );

        session.subscribe((event) => {
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent.type === "text_delta"
          ) {
            Effect.runSync(Effect.logDebug(event.assistantMessageEvent.delta));
          }
        });

        yield* Effect.logInfo("Sending structured request");
        yield* Effect.tryPromise({
          try: () => session.prompt(renderRequestPrompt(request)),
          catch: (cause) =>
            new SessionFailureError({ message: "session.prompt() failed", cause }),
        });
        if (session.agent.state.errorMessage) {
          yield* Effect.logWarning(`agent error: ${session.agent.state.errorMessage}`);
        }

        if (submitted === undefined) {
          const last = session.messages.findLast(
            (m): m is AssistantMessage => m.role === "assistant",
          );
          const text = (last?.content ?? [])
            .filter((c): c is TextContent => c.type === "text")
            .map((c) => c.text)
            .join("");
          const calls = (last?.content ?? [])
            .filter((c): c is ToolCall => c.type === "toolCall")
            .map((c) => `${c.name}(${JSON.stringify(c.arguments)})`);
          yield* Effect.logWarning(`active tools: ${session.getActiveToolNames().join(", ")}`);
          yield* Effect.logWarning(`last assistant text: ${text}`);
          yield* Effect.logWarning(`last assistant tool calls: ${calls.join(", ") || "(none)"}`);
          return yield* new NoSubmissionError({
            message: "agent finished without calling submit_result",
          });
        }

        yield* Effect.logInfo("Validating submitted result");
        const result = yield* Schema.decodeUnknownEffect(
          EchoResultForRequest(request),
        )(submitted).pipe(
          Effect.mapError((cause) =>
            new InvalidResultError({ message: "submit_result payload failed validation", cause }),
          ),
        );

        yield* Effect.logInfo("Structured result received");
        return result;
      });

      return PiHarness.of({ execute });
    }),
  );
}
