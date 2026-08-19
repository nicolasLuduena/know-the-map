import { describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { AnalysisSchedulerService, makeAnalysisSchedulerLayer } from "./index";

const run = <A, E>(effect: Effect.Effect<A, E, AnalysisSchedulerService>) =>
	Effect.runPromise(
		effect.pipe(
			Effect.provide(makeAnalysisSchedulerLayer({ defaultConcurrency: 1 })),
			Effect.scoped,
		),
	);

describe("AnalysisScheduler", () => {
	test("runs later visible work before queued background work", async () => {
		const order: Array<string> = [];
		await run(
			Effect.gen(function* () {
				const scheduler = yield* AnalysisSchedulerService;
				const first = yield* scheduler
					.submit({
						key: "b1",
						backend: "agent",
						priority: "background",
						task: Effect.sleep("30 millis").pipe(
							Effect.tap(() => Effect.sync(() => order.push("b1"))),
						),
					})
					.pipe(Effect.fork);
				const second = yield* scheduler
					.submit({
						key: "b2",
						backend: "agent",
						priority: "background",
						task: Effect.sync(() => order.push("b2")),
					})
					.pipe(Effect.fork);
				yield* Effect.sleep("5 millis");
				const visible = yield* scheduler
					.submit({
						key: "visible",
						backend: "agent",
						priority: "visible",
						task: Effect.sync(() => order.push("visible")),
					})
					.pipe(Effect.fork);
				yield* Effect.all(
					[Fiber.join(first), Fiber.join(second), Fiber.join(visible)],
					{ concurrency: "unbounded" },
				);
			}),
		);
		expect(order).toEqual(["b1", "visible", "b2"]);
	});

	test("deduplicates work and preserves it while one subscriber remains", async () => {
		let runs = 0;
		const value = await run(
			Effect.gen(function* () {
				const scheduler = yield* AnalysisSchedulerService;
				const task = Effect.sync(() => {
					runs += 1;
				}).pipe(Effect.zipRight(Effect.sleep("25 millis")), Effect.as(42));
				const one = yield* scheduler
					.submit({ key: "same", backend: "agent", priority: "visible", task })
					.pipe(Effect.fork);
				const two = yield* scheduler
					.submit({ key: "same", backend: "agent", priority: "visible", task })
					.pipe(Effect.fork);
				yield* Effect.sleep("5 millis");
				yield* Fiber.interrupt(one);
				return yield* Fiber.join(two);
			}),
		);
		expect(value).toBe(42);
		expect(runs).toBe(1);
	});

	test("interrupts underlying work when the final subscriber leaves", async () => {
		let state = "pending";
		await run(
			Effect.gen(function* () {
				const scheduler = yield* AnalysisSchedulerService;
				const waiter = yield* scheduler
					.submit({
						key: "cancel",
						backend: "agent",
						priority: "visible",
						task: Effect.sleep("100 millis").pipe(
							Effect.tap(() =>
								Effect.sync(() => {
									state = "completed";
								}),
							),
							Effect.onInterrupt(() =>
								Effect.sync(() => {
									state = "interrupted";
								}),
							),
						),
					})
					.pipe(Effect.fork);
				yield* Effect.sleep("10 millis");
				yield* Fiber.interrupt(waiter);
				yield* Effect.sleep("10 millis");
			}),
		);
		expect(state).toBe("interrupted");
	});
});
