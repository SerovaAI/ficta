// Engine-local warning sink.
//
// The redaction engine must not depend on the product's pino logger (`logger.ts`) — that keeps the
// engine's import graph free of pino and the CLI. Detector-domain warnings (e.g. a PII backend being
// unavailable) go through a sink injected per engine instance (`new ProtectionEngine({ onWarn })`)
// and handed to plugins on their `PluginRuntime`.
//
// Default is a no-op: a bare-library engine (unit tests, embedding, the browser-extension reuse path)
// is silent-but-correct until a host passes a real sink. The ficta proxy passes pino's warn (see
// `startProxy` in `server.ts`). The signature mirrors pino's `log.warn(fields, message)` so wiring is
// a one-liner and tests can pass a capturing sink.
export type WarnFields = Record<string, unknown>;

export type WarnSink = (fields: WarnFields, message: string) => void;

export const noopWarnSink: WarnSink = () => {};
