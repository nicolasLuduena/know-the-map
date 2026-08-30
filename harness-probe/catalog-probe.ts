import { Effect, Runtime } from "effect";
import { OpenCode } from "@opencode-ai/sdk/effect";
import { OPENCODE_CONFIG } from "./src/opencode-config.ts";

const program = Effect.gen(function* () {
  const opencode = yield* OpenCode.create({
    config: {
      directory: "/tmp/opencode/xdg-empty/opencode",
      content: JSON.stringify(OPENCODE_CONFIG),
    },
  });
  const sessions = yield* opencode.sessions.list({ limit: 5, order: "desc" });
  yield* Effect.logInfo(`Found ${sessions.data.length} recent sessions`);
  for (const session of sessions.data) {
    const exported = yield* opencode.sessions.export({ sessionID: session.id });
    const last = exported.messages.at(-1);
    yield* Effect.logInfo(
      `${session.id} ${session.title}: ${
        last?.type === "assistant" ? last.finish : last?.type ?? "empty"
      }`,
    );
  }
}).pipe(Effect.scoped);

Runtime.makeRunMain(({ fiber, teardown }) => {
  fiber.addObserver((exit) => {
    teardown(exit, (code) => process.exit(code));
  });
})(program);
