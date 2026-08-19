import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CacheStore } from "@bleentr/plugin-api";
import { makePluginRegistryLayer, PluginRegistry } from "@bleentr/plugin-api";
import { Context, Effect, Layer, Option } from "effect";
import { makeSqlitePlugin } from "./index";

const directories: Array<string> = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

const withStore = <A, E>(f: (store: CacheStore) => Effect.Effect<A, E>) => {
	const directory = mkdtempSync(join(tmpdir(), "wth-sqlite-"));
	directories.push(directory);
	const layer = makePluginRegistryLayer([
		makeSqlitePlugin({ path: join(directory, "cache.sqlite") }),
	]);
	return Effect.scoped(
		Effect.gen(function* () {
			const context = yield* Layer.build(layer);
			const store = Context.get(context, PluginRegistry).cacheStores.get(
				"wth.sqlite",
			);
			if (store === undefined) return yield* Effect.die("cache store missing");
			return yield* f(store);
		}),
	);
};

describe("SQLite cache", () => {
	test("stores, replaces, and deletes entries", async () => {
		await Effect.runPromise(
			withStore((store) =>
				Effect.gen(function* () {
					yield* store.set("key", {
						value: "one",
						storedAt: "2026-01-01T00:00:00.000Z",
					});
					const first = yield* store.get("key");
					expect(Option.getOrThrow(first).value).toBe("one");
					yield* store.set("key", {
						value: "two",
						storedAt: "2026-01-02T00:00:00.000Z",
					});
					expect(Option.getOrThrow(yield* store.get("key")).value).toBe("two");
					yield* store.delete("key");
					expect(Option.isNone(yield* store.get("key"))).toBe(true);
				}),
			),
		);
	});

	test("evicts expired entries", async () => {
		await Effect.runPromise(
			withStore((store) =>
				Effect.gen(function* () {
					yield* store.set("expired", {
						value: "old",
						storedAt: "2000-01-01T00:00:00.000Z",
						expiresAt: "2000-01-02T00:00:00.000Z",
					});
					expect(Option.isNone(yield* store.get("expired"))).toBe(true);
				}),
			),
		);
	});
});
