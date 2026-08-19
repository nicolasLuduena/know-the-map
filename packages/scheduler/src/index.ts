import {
	Deferred,
	Effect,
	type Exit,
	Fiber,
	Layer,
	Queue,
	Schema,
} from "effect";

export type SchedulerPriority = "visible" | "adjacent" | "background";

export interface SchedulerConfig {
	readonly defaultConcurrency: number;
	readonly backendConcurrency?: Readonly<Record<string, number>>;
}

export class SchedulerConfigError extends Schema.TaggedError<SchedulerConfigError>()(
	"SchedulerConfigError",
	{ message: Schema.String },
) {}

export interface SchedulerSubmitInput<A, E> {
	readonly key: string;
	readonly backend: string;
	readonly priority: SchedulerPriority;
	readonly task: Effect.Effect<A, E>;
}

export interface AnalysisScheduler {
	readonly submit: <A, E>(
		input: SchedulerSubmitInput<A, E>,
	) => Effect.Effect<A, E>;
}

interface Job {
	readonly key: string;
	readonly backend: string;
	readonly priority: SchedulerPriority;
	readonly task: Effect.Effect<unknown, unknown>;
	readonly deferred: Deferred.Deferred<unknown, unknown>;
	waiters: number;
	started: boolean;
	fiber?: Fiber.RuntimeFiber<unknown, unknown>;
}

export class AnalysisSchedulerService extends Effect.Tag(
	"wth/AnalysisScheduler",
)<AnalysisSchedulerService, AnalysisScheduler>() {}

const priorityRank: Readonly<Record<SchedulerPriority, number>> = {
	visible: 0,
	adjacent: 1,
	background: 2,
};

const validateConfig = (
	config: SchedulerConfig,
): Effect.Effect<void, SchedulerConfigError> => {
	const values = [
		config.defaultConcurrency,
		...Object.values(config.backendConcurrency ?? {}),
	];
	return values.every((value) => Number.isInteger(value) && value > 0)
		? Effect.void
		: Effect.fail(
				new SchedulerConfigError({
					message: "scheduler concurrency limits must be positive integers",
				}),
			);
};

export const makeAnalysisSchedulerLayer = (
	config: SchedulerConfig,
): Layer.Layer<AnalysisSchedulerService, SchedulerConfigError> =>
	Layer.scoped(
		AnalysisSchedulerService,
		Effect.gen(function* () {
			yield* validateConfig(config);
			const mutex = yield* Effect.makeSemaphore(1);
			const wake = yield* Queue.unbounded<void>();
			const pending: Array<Job> = [];
			const inflight = new Map<string, Job>();
			const running = new Map<string, number>();

			const limitFor = (backend: string): number =>
				config.backendConcurrency?.[backend] ?? config.defaultConcurrency;

			const selectJobs = mutex.withPermits(1)(
				Effect.sync(() => {
					const selected: Array<Job> = [];
					while (true) {
						let selectedIndex = -1;
						for (let index = 0; index < pending.length; index += 1) {
							const candidate = pending[index];
							if (candidate === undefined) continue;
							if (
								(running.get(candidate.backend) ?? 0) >=
								limitFor(candidate.backend)
							)
								continue;
							const current =
								selectedIndex < 0 ? undefined : pending[selectedIndex];
							if (
								current === undefined ||
								priorityRank[candidate.priority] <
									priorityRank[current.priority]
							) {
								selectedIndex = index;
							}
						}
						if (selectedIndex < 0) break;
						const [job] = pending.splice(selectedIndex, 1);
						if (job === undefined) break;
						job.started = true;
						running.set(job.backend, (running.get(job.backend) ?? 0) + 1);
						selected.push(job);
					}
					return selected;
				}),
			);

			const complete = (job: Job, exit: Exit.Exit<unknown, unknown>) =>
				Effect.gen(function* () {
					yield* mutex.withPermits(1)(
						Effect.sync(() => {
							if (inflight.get(job.key) === job) inflight.delete(job.key);
							running.set(
								job.backend,
								Math.max(0, (running.get(job.backend) ?? 1) - 1),
							);
						}),
					);
					yield* Deferred.done(job.deferred, exit);
					yield* Queue.offer(wake, undefined);
				});

			const runJob = (job: Job) =>
				Effect.uninterruptibleMask((restore) =>
					restore(job.task).pipe(
						Effect.exit,
						Effect.flatMap((exit) => complete(job, exit)),
					),
				);

			const dispatch = Effect.gen(function* () {
				const jobs = yield* selectJobs;
				for (const job of jobs) {
					const fiber = yield* runJob(job).pipe(Effect.forkScoped);
					yield* mutex.withPermits(1)(
						Effect.sync(() => {
							job.fiber = fiber;
						}),
					);
				}
			});

			yield* Queue.take(wake).pipe(
				Effect.flatMap(() => dispatch),
				Effect.forever,
				Effect.forkScoped,
			);

			const releaseWaiter = (job: Job) =>
				Effect.gen(function* () {
					const fiber = yield* mutex.withPermits(1)(
						Effect.sync(() => {
							job.waiters = Math.max(0, job.waiters - 1);
							if (job.waiters > 0 || inflight.get(job.key) !== job)
								return undefined;
							inflight.delete(job.key);
							if (!job.started) {
								const index = pending.indexOf(job);
								if (index >= 0) pending.splice(index, 1);
							}
							return job.fiber;
						}),
					);
					if (fiber !== undefined) yield* Fiber.interrupt(fiber);
				});

			return {
				submit: <A, E>(
					input: SchedulerSubmitInput<A, E>,
				): Effect.Effect<A, E> =>
					Effect.gen(function* () {
						const freshDeferred = yield* Deferred.make<unknown, unknown>();
						const result = yield* mutex.withPermits(1)(
							Effect.sync(() => {
								const existing = inflight.get(input.key);
								if (existing !== undefined) {
									existing.waiters += 1;
									return { job: existing, created: false } as const;
								}
								const job: Job = {
									key: input.key,
									backend: input.backend,
									priority: input.priority,
									task: input.task,
									deferred: freshDeferred,
									waiters: 1,
									started: false,
								};
								inflight.set(input.key, job);
								pending.push(job);
								return { job, created: true } as const;
							}),
						);
						if (result.created) yield* Queue.offer(wake, undefined);
						const awaited = Deferred.await(result.job.deferred).pipe(
							Effect.onInterrupt(() => releaseWaiter(result.job)),
						) as Effect.Effect<A, E>;
						return yield* awaited;
					}),
			};
		}),
	);
