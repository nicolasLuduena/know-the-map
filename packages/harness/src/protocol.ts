import { Schema } from "effect";

/**
 * The single exchange a harness performs: one structured request in, one
 * structured result out.
 *
 * TODO: The real request shape is undesigned. Keep this empty until the
 * protocol between the leader and the model sessions is settled — every field
 * added here becomes part of the contract both harnesses must satisfy.
 */
export const HarnessRequest = Schema.Struct({});
export type HarnessRequest = Schema.Schema.Type<typeof HarnessRequest>;

/**
 * TODO: The real result shape is undesigned. Same contract warning as
 * `HarnessRequest`: empty on purpose, do not grow it casually.
 */
export const HarnessResult = Schema.Struct({});
export type HarnessResult = Schema.Schema.Type<typeof HarnessResult>;
