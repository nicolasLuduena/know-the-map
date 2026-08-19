import { Database } from "bun:sqlite";
import type {
	CacheEntry,
	CacheStore,
	PluginDefinition,
} from "@bleentr/plugin-api";
import {
	CacheEntrySchema,
	CacheError,
	definePlugin,
	PluginInitError,
} from "@bleentr/plugin-api";
import { Clock, Effect, Option, Schema } from "effect";

const pluginId = "wth.sqlite";

export interface SqlitePluginConfig {
	readonly path: string;
}

interface CacheRow {
	readonly value: string;
	readonly stored_at: string;
	readonly expires_at: string | null;
}

const initialize = (db: Database): void => {
	const version =
		db.query<{ readonly user_version: number }, []>("PRAGMA user_version").get()
			?.user_version ?? 0;
	if (version > 1)
		throw new Error(
			`database schema version ${version} is newer than supported version 1`,
		);
	if (version === 0) {
		db.run("BEGIN IMMEDIATE");
		try {
			db.run(
				"CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, stored_at TEXT NOT NULL, expires_at TEXT)",
			);
			db.run("PRAGMA user_version = 1");
			db.run("COMMIT");
		} catch (error) {
			db.run("ROLLBACK");
			throw error;
		}
	}
};

const cacheError = (message: string): CacheError =>
	new CacheError({ capabilityId: pluginId, message });

const makeStore = (db: Database): CacheStore => ({
	id: pluginId,
	version: "1",
	get: (key) =>
		Effect.gen(function* () {
			const row = yield* Effect.try({
				try: () =>
					db
						.query<CacheRow, [string]>(
							"SELECT value, stored_at, expires_at FROM cache WHERE key = ?",
						)
						.get(key),
				catch: (error) =>
					cacheError(`failed to read cache entry: ${String(error)}`),
			});
			if (row === null) return Option.none<CacheEntry>();
			const entry = yield* Effect.try({
				try: () =>
					Schema.decodeUnknownSync(CacheEntrySchema)({
						value: row.value,
						storedAt: row.stored_at,
						...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
					}),
				catch: (error) =>
					cacheError(`failed to decode cache entry: ${String(error)}`),
			});
			const now = yield* Clock.currentTimeMillis;
			if (entry.expiresAt !== undefined && Date.parse(entry.expiresAt) <= now) {
				yield* Effect.try({
					try: () =>
						db
							.query<unknown, [string]>("DELETE FROM cache WHERE key = ?")
							.run(key),
					catch: (error) =>
						cacheError(
							`failed to delete expired cache entry: ${String(error)}`,
						),
				});
				return Option.none<CacheEntry>();
			}
			return Option.some(entry);
		}),
	set: (key, entry) =>
		Effect.gen(function* () {
			const encoded = yield* Effect.try({
				try: () => Schema.encodeSync(CacheEntrySchema)(entry),
				catch: (error) =>
					cacheError(`failed to encode cache entry: ${String(error)}`),
			});
			yield* Effect.try({
				try: () =>
					db
						.query<unknown, [string, string, string, string | null]>(
							"INSERT INTO cache (key, value, stored_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, stored_at=excluded.stored_at, expires_at=excluded.expires_at",
						)
						.run(
							key,
							encoded.value,
							encoded.storedAt,
							encoded.expiresAt ?? null,
						),
				catch: (error) =>
					cacheError(`failed to write cache entry: ${String(error)}`),
			});
		}),
	delete: (key) =>
		Effect.try({
			try: () =>
				db.query<unknown, [string]>("DELETE FROM cache WHERE key = ?").run(key),
			catch: (error) =>
				cacheError(`failed to delete cache entry: ${String(error)}`),
		}).pipe(Effect.asVoid),
});

export const makeSqlitePlugin = (
	config: SqlitePluginConfig,
): PluginDefinition =>
	definePlugin({
		id: pluginId,
		version: "1",
		apiVersion: 1,
		build: Effect.gen(function* () {
			const db = yield* Effect.acquireRelease(
				Effect.try({
					try: () => new Database(config.path, { create: true }),
					catch: (error) =>
						new PluginInitError({
							pluginId,
							message: `failed to open database: ${String(error)}`,
						}),
				}),
				(db) => Effect.sync(() => db.close()),
			);
			yield* Effect.try({
				try: () => initialize(db),
				catch: (error) =>
					new PluginInitError({
						pluginId,
						message: `failed to migrate database: ${String(error)}`,
					}),
			});
			return { cacheStores: [makeStore(db)] };
		}),
	});
