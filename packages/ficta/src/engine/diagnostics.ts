// Engine-local warning sink.
//
// The redaction engine must not depend on the product's pino logger (`logger.ts`) — that keeps the
// engine's import graph free of pino and the CLI. Detector-domain warnings (e.g. a PII backend being
// unavailable) go through this injectable sink instead.
//
// Default is a no-op: a bare-library engine (unit tests, future embedding, the browser-extension
// reuse path) is silent-but-correct until a host wires a real sink. ficta wires pino once at startup
// (see `setEngineWarnSink` calls in `cli.ts` / `server.ts`). The signature mirrors pino's
// `log.warn(fields, message)` so wiring is a one-liner and tests can install a capturing sink.
type WarnFields = Record<string, unknown>;

let sink: (fields: WarnFields, message: string) => void = () => {};

export function setEngineWarnSink(fn: (fields: WarnFields, message: string) => void): void {
  sink = fn;
}

export function engineWarn(fields: WarnFields, message: string): void {
  sink(fields, message);
}
