import { Deferred, Effect, Queue, Schema } from "effect";

export type SchedulerPriority = "visible" | "adjacent" | "background";

export class SchedulerError extends Schema.TaggedError<SchedulerError>()(
	"SchedulerError",
	{
		message: Schema.String,
	},
) {}

export interface SchedulerSubmitInput<A, E> {
	readonly key: string;
	readonly backend: string;
	readonly priority: SchedulerPriority;
	readonly task: Effect.Effect<A, E>;
}

interface Envelope {
	readonly backend: string;
	readonly task: Effect.Effect<unknown, unknown>;
	readonly deferred: Deferred.Deferred<unknown, unknown>;
}

export class AnalysisSchedulerService extends Effect.Service<AnalysisSchedulerService>()(
	"wth/AnalysisSchedulerService",
	{
		effect: Effect.gen(function* () {
			const queues = {
				visible: yield* Queue.unbounded<Envelope>(),
				adjacent: yield* Queue.unbounded<Envelope>(),
				background: yield* Queue.unbounded<Envelope>(),
			};
			const permits = new Map<string, Effect.Semaphore>();
			const inflight = new Map<string, Deferred.Deferred<unknown, unknown>>();

			const getPermit = (backend: string) =>
				Effect.gen(function* () {
					const existing = permits.get(backend);
					if (existing) return existing;
					const created = yield* Effect.makeSemaphore(1);
					permits.set(backend, created);
					return created;
				});

			// Poll loop: blocking Queue.take on a single queue would starve higher-priority offers.
			const takeNext = (): Effect.Effect<Envelope> =>
				Effect.gen(function* () {
					const visible = yield* Queue.poll(queues.visible);
					if (visible._tag === "Some") return visible.value;
					const adjacent = yield* Queue.poll(queues.adjacent);
					if (adjacent._tag === "Some") return adjacent.value;
					const background = yield* Queue.poll(queues.background);
					if (background._tag === "Some") return background.value;
					yield* Effect.sleep("10 millis");
					return yield* takeNext();
				});

			const drain = Effect.gen(function* () {
				const envelope = yield* takeNext();
				yield* Effect.gen(function* () {
					const permit = yield* getPermit(envelope.backend);
					yield* permit.withPermits(1)(
						Effect.gen(function* () {
							const exit = yield* envelope.task.pipe(Effect.exit);
							yield* Deferred.done(envelope.deferred, exit);
						}),
					);
				}).pipe(Effect.forkScoped);
			});

			yield* drain.pipe(Effect.forever, Effect.forkScoped);

			return {
				submit: <A, E>(
					input: SchedulerSubmitInput<A, E>,
				): Effect.Effect<A, E | SchedulerError> =>
					Effect.gen(function* () {
						const existing = inflight.get(input.key);
						if (existing) {
							const result = yield* Deferred.await(existing) as Effect.Effect<
								unknown,
								E | SchedulerError
							>;
							return result as A;
						}
						const deferred = yield* Deferred.make<unknown, unknown>();
						inflight.set(input.key, deferred);
						yield* Queue.offer(queues[input.priority], {
							backend: input.backend,
							task: input.task,
							deferred,
						});
						const result = yield* Deferred.await(deferred).pipe(
							Effect.onExit(() =>
								Effect.sync(() => inflight.delete(input.key)),
							),
							Effect.onInterrupt(() =>
								Effect.sync(() => inflight.delete(input.key)),
							),
						) as Effect.Effect<unknown, E | SchedulerError>;
						return result as A;
					}),
			};
		}),
	},
) {}
