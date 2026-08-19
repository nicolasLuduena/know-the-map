import { describe, expect, test } from "bun:test";
import { Context, Effect, Layer, Stream } from "effect";
import {
	definePlugin,
	makePluginRegistryLayer,
	PluginInitError,
	PluginRegistry,
} from "./index";

const buildRegistry = (
	definitions: Parameters<typeof makePluginRegistryLayer>[0],
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const context = yield* Layer.build(makePluginRegistryLayer(definitions));
			return Context.get(context, PluginRegistry);
		}),
	);

describe("PluginRegistry", () => {
	test("aggregates contributions instead of overwriting earlier plugins", async () => {
		const source = {
			id: "source",
			version: "1",
			resolve: () => Effect.die("unused"),
		};
		const runner = {
			id: "runner",
			version: "1",
			capabilities: { streaming: true, tools: false, maxContextTokens: 1 },
			run: () => Stream.empty,
		};
		const registry = await Effect.runPromise(
			buildRegistry([
				definePlugin({
					id: "git",
					version: "1",
					apiVersion: 1,
					build: Effect.succeed({ diffSources: [source] }),
				}),
				definePlugin({
					id: "agent",
					version: "1",
					apiVersion: 1,
					build: Effect.succeed({ agentRunners: [runner] }),
				}),
			]),
		);
		expect([...registry.diffSources.keys()]).toEqual(["source"]);
		expect([...registry.agentRunners.keys()]).toEqual(["runner"]);
	});

	test("rejects duplicate capability ids", async () => {
		const source = {
			id: "same",
			version: "1",
			resolve: () => Effect.die("unused"),
		};
		const exit = await Effect.runPromiseExit(
			buildRegistry([
				definePlugin({
					id: "one",
					version: "1",
					apiVersion: 1,
					build: Effect.succeed({ diffSources: [source] }),
				}),
				definePlugin({
					id: "two",
					version: "1",
					apiVersion: 1,
					build: Effect.succeed({ diffSources: [source] }),
				}),
			]),
		);
		expect(exit._tag).toBe("Failure");
	});

	test("releases plugin resources with the registry scope", async () => {
		let released = false;
		const plugin = definePlugin({
			id: "scoped",
			version: "1",
			apiVersion: 1,
			build: Effect.acquireRelease(Effect.succeed({}), () =>
				Effect.sync(() => {
					released = true;
				}),
			),
		});
		await Effect.runPromise(buildRegistry([plugin]));
		expect(released).toBe(true);
	});

	test("surfaces typed initialization failures", async () => {
		const plugin = definePlugin({
			id: "bad",
			version: "1",
			apiVersion: 1,
			build: Effect.fail(
				new PluginInitError({ pluginId: "bad", message: "bad config" }),
			),
		});
		const exit = await Effect.runPromiseExit(buildRegistry([plugin]));
		expect(exit._tag).toBe("Failure");
	});
});
