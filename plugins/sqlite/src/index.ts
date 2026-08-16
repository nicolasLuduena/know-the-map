import { Database } from "bun:sqlite";
import type { HunkId } from "@bleentr/domain";
import type {
	Annotation,
	CacheEntry,
	CacheStore,
	ReviewStore,
} from "@bleentr/plugin-api";
import {
	AnnotationSchema,
	CacheEntrySchema,
	CacheError,
	definePlugin,
	ReviewStoreError,
} from "@bleentr/plugin-api";
import { DateTime, Effect, Option, Schema } from "effect";

// -- Database access -----------------------------------------------------------

/**
 * Location of the SQLite database file. Overridable via `WTH_SQLITE_PATH`;
 * defaults to `./wth.sqlite` in the current working directory.
 */
// biome-ignore lint/complexity/useLiteralKeys: quoted access is required by the `noPropertyAccessFromIndexSignature` compiler option
const dbPath = (): string => process.env["WTH_SQLITE_PATH"] ?? "./wth.sqlite";

/**
 * Run a single operation against SQLite.
 *
 * MVP simplification: a connection is opened for each call and closed once the
 * operation completes (successfully or not); no connection pool is shared.
 * The schema is ensured to exist before the operation runs. Connection-level
 * failures are mapped through the caller-provided `toError` factory so that
 * cache operations surface `CacheError` and review operations surface
 * `ReviewStoreError`.
 */
const useDb = <A, E extends CacheError | ReviewStoreError>(
	f: (db: Database) => Effect.Effect<A, E>,
	toError: (message: string) => E,
): Effect.Effect<A, E> =>
	Effect.gen(function* () {
		const db = yield* Effect.try({
			try: () => new Database(dbPath(), { create: true }),
			catch: (error) => toError(`failed to open database: ${String(error)}`),
		});
		return yield* Effect.gen(function* () {
			yield* Effect.try({
				try: () => setupSchema(db),
				catch: (error) =>
					toError(`failed to initialize database schema: ${String(error)}`),
			});
			return yield* f(db);
		}).pipe(Effect.ensuring(Effect.sync(() => db.close())));
	});

/** Ensure the storage tables exist (idempotent). */
const setupSchema = (db: Database): void => {
	db.run(
		"CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, stored_at TEXT NOT NULL, expires_at TEXT)",
	);
	db.run("CREATE TABLE IF NOT EXISTS viewed (hunk_id TEXT PRIMARY KEY)");
	db.run(
		"CREATE TABLE IF NOT EXISTS annotations (hunk_id TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL)",
	);
};

// -- Row shapes ----------------------------------------------------------------

interface CacheRow {
	readonly value: string;
	readonly stored_at: string;
	readonly expires_at: string | null;
}

interface AnnotationRow {
	readonly hunk_id: string;
	readonly text: string;
	readonly created_at: string;
}

// -- CacheStore capability -----------------------------------------------------

const cacheStore: CacheStore = {
	id: "wth.sqlite",
	get: (key) =>
		useDb(
			(db) =>
				Effect.gen(function* () {
					const row = yield* Effect.try({
						try: () =>
							db
								.query<CacheRow, [string]>(
									"SELECT value, stored_at, expires_at FROM cache WHERE key = ?",
								)
								.get(key),
						catch: (error) =>
							new CacheError({
								message: `failed to read cache entry: ${String(error)}`,
							}),
					});
					if (row === null) return Option.none<CacheEntry>();
					const entry = yield* Effect.try({
						try: () =>
							Schema.decodeUnknownSync(CacheEntrySchema)({
								value: row.value,
								storedAt: row.stored_at,
								expiresAt: row.expires_at ?? undefined,
							}),
						catch: (error) =>
							new CacheError({
								message: `failed to decode cache entry: ${String(error)}`,
							}),
					});
					const expired = Option.match(entry.expiresAt, {
						onNone: () => false,
						onSome: (expiresAt) =>
							DateTime.lessThan(expiresAt, DateTime.unsafeNow()),
					});
					if (expired) {
						yield* Effect.try({
							try: () =>
								db
									.query<unknown, [string]>("DELETE FROM cache WHERE key = ?")
									.run(key),
							catch: (error) =>
								new CacheError({
									message: `failed to delete expired cache entry: ${String(error)}`,
								}),
						});
						return Option.none<CacheEntry>();
					}
					return Option.some(entry);
				}),
			(message) => new CacheError({ message }),
		),
	set: (key, entry) =>
		useDb(
			(db) =>
				Effect.gen(function* () {
					const encoded = yield* Effect.try({
						try: () => Schema.encodeSync(CacheEntrySchema)(entry),
						catch: (error) =>
							new CacheError({
								message: `failed to encode cache entry: ${String(error)}`,
							}),
					});
					yield* Effect.try({
						try: () =>
							db
								.query<unknown, [string, string, string, string | null]>(
									"INSERT OR REPLACE INTO cache (key, value, stored_at, expires_at) VALUES (?, ?, ?, ?)",
								)
								.run(
									key,
									encoded.value,
									encoded.storedAt,
									encoded.expiresAt ?? null,
								),
						catch: (error) =>
							new CacheError({
								message: `failed to write cache entry: ${String(error)}`,
							}),
					});
				}),
			(message) => new CacheError({ message }),
		),
	delete: (key) =>
		useDb(
			(db) =>
				Effect.try({
					try: () =>
						db
							.query<unknown, [string]>("DELETE FROM cache WHERE key = ?")
							.run(key),
					catch: (error) =>
						new CacheError({
							message: `failed to delete cache entry: ${String(error)}`,
						}),
				}),
			(message) => new CacheError({ message }),
		),
};

// -- ReviewStore capability ----------------------------------------------------

const reviewStore: ReviewStore = {
	id: "wth.sqlite",
	markViewed: (hunkId: HunkId) =>
		useDb(
			(db) =>
				Effect.try({
					try: () =>
						db
							.query<unknown, [string]>(
								"INSERT OR REPLACE INTO viewed (hunk_id) VALUES (?)",
							)
							.run(hunkId),
					catch: (error) =>
						new ReviewStoreError({
							message: `failed to mark hunk as viewed: ${String(error)}`,
						}),
				}),
			(message) => new ReviewStoreError({ message }),
		),
	isViewed: (hunkId: HunkId) =>
		useDb(
			(db) =>
				Effect.try({
					try: () =>
						db
							.query<{ readonly one: number }, [string]>(
								"SELECT 1 AS one FROM viewed WHERE hunk_id = ? LIMIT 1",
							)
							.get(hunkId) !== null,
					catch: (error) =>
						new ReviewStoreError({
							message: `failed to check viewed status: ${String(error)}`,
						}),
				}),
			(message) => new ReviewStoreError({ message }),
		),
	saveAnnotation: (annotation: Annotation) =>
		useDb(
			(db) =>
				Effect.gen(function* () {
					const encoded = yield* Effect.try({
						try: () => Schema.encodeSync(AnnotationSchema)(annotation),
						catch: (error) =>
							new ReviewStoreError({
								message: `failed to encode annotation: ${String(error)}`,
							}),
					});
					yield* Effect.try({
						try: () =>
							db
								.query<unknown, [string, string, string]>(
									"INSERT INTO annotations (hunk_id, text, created_at) VALUES (?, ?, ?)",
								)
								.run(encoded.hunkId, encoded.text, encoded.createdAt),
						catch: (error) =>
							new ReviewStoreError({
								message: `failed to save annotation: ${String(error)}`,
							}),
					});
				}),
			(message) => new ReviewStoreError({ message }),
		),
	annotations: (hunkId: HunkId) =>
		useDb(
			(db) =>
				Effect.gen(function* () {
					const rows = yield* Effect.try({
						try: () =>
							db
								.query<AnnotationRow, [string]>(
									"SELECT hunk_id, text, created_at FROM annotations WHERE hunk_id = ? ORDER BY created_at",
								)
								.all(hunkId),
						catch: (error) =>
							new ReviewStoreError({
								message: `failed to load annotations: ${String(error)}`,
							}),
					});
					return yield* Effect.try({
						try: () =>
							rows.map((row) =>
								Schema.decodeUnknownSync(AnnotationSchema)({
									hunkId: row.hunk_id,
									text: row.text,
									createdAt: row.created_at,
								}),
							),
						catch: (error) =>
							new ReviewStoreError({
								message: `failed to decode annotations: ${String(error)}`,
							}),
					});
				}),
			(message) => new ReviewStoreError({ message }),
		),
};

export default definePlugin({
	id: "wth.sqlite",
	apiVersion: 1,
	capabilities: {
		cacheStores: [cacheStore],
		reviewStores: [reviewStore],
	},
});
