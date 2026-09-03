import { Effect } from "effect";

/**
 * Fails with a lazily built typed error when `condition` does not hold.
 * Use it for preconditions with no value under test; when the condition
 * checks an effect's own value, prefer `Effect.filterOrFail` (it also
 * narrows the success type). Error construction is deferred on purpose:
 * an eager `assert(condition, error)` would build the error — and capture
 * its stack — on every successful call too.
 */
export const guard = <E>(condition: boolean, onFailure: () => E): Effect.Effect<void, E> =>
  condition ? Effect.void : Effect.fail(onFailure());
