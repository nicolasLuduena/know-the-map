import type {
	AgentEvent,
	AgentRequest,
	AgentRunner,
} from "@bleentr/plugin-api";
import { AgentRunnerError, definePlugin } from "@bleentr/plugin-api";
import { Effect, Stream } from "effect";

/**
 * Adapter seam: replaces the streaming loop when the OpenCode V2 Effect-native SDK stabilizes.
 */
const collectEvents = (
	request: AgentRequest,
): Effect.Effect<ReadonlyArray<AgentEvent>, AgentRunnerError> =>
	Effect.tryPromise({
		try: async () => {
			const proc = Bun.spawn(["opencode", "run"], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});

			await proc.stdin.write(request.prompt);
			await proc.stdin.end();

			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			const exitCode = await proc.exited;

			if (exitCode !== 0) {
				const detail = stderr.trim();
				throw new AgentRunnerError({
					message:
						detail !== ""
							? detail
							: `opencode run exited with code ${exitCode}`,
				});
			}

			const lines = stdout.split("\n").filter((line) => line.length > 0);
			return [
				...lines.map((line): AgentEvent => ({ _tag: "Text", text: line })),
				{ _tag: "Done", output: stdout },
			];
		},
		catch: (error) =>
			error instanceof AgentRunnerError
				? error
				: new AgentRunnerError({
						message: error instanceof Error ? error.message : String(error),
					}),
	});

const openCodeRunner: AgentRunner = {
	id: "wth.opencode-v2",
	capabilities: { streaming: false, tools: true, maxContextTokens: 128000 },
	run: (request) =>
		Stream.unwrap(
			Effect.gen(function* () {
				const events = yield* collectEvents(request);
				return Stream.fromIterable(events);
			}),
		),
};

export default definePlugin({
	id: "wth.opencode-v2",
	apiVersion: 1,
	capabilities: {
		agentRunners: [openCodeRunner],
	},
});
