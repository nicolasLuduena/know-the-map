import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import {
	makePluginRegistryLayer,
	PluginRegistry,
} from "../packages/plugin-api/src/index";
import gitPlugin from "../plugins/git/src/index";
import { makeSqlitePlugin } from "../plugins/sqlite/src/index";

test("real Git and SQLite plugins compose without overwriting capabilities", async () => {
	const directory = mkdtempSync(join(tmpdir(), "wth-runtime-"));
	try {
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const context = yield* Layer.build(
						makePluginRegistryLayer([
							gitPlugin,
							makeSqlitePlugin({ path: join(directory, "cache.sqlite") }),
						]),
					);
					const registry = Context.get(context, PluginRegistry);
					return {
						diffSources: [...registry.diffSources.keys()],
						cacheStores: [...registry.cacheStores.keys()],
					};
				}),
			),
		);
		expect(result).toEqual({
			diffSources: ["wth.git"],
			cacheStores: ["wth.sqlite"],
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
