/**
 * OpenCode remains behind the `AgentRunner` capability. A concrete adapter is
 * intentionally deferred until it can expose structured events and scoped
 * cancellation without buffering or pretending formatted stdout is a stream.
 */
export const OPEN_CODE_V2_PLUGIN_ID = "wth.opencode-v2";
