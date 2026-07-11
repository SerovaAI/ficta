import type { RuntimeTraceCaptureState } from "@serovaai/ficta-protocol";

export const RUNTIME_TRACE_CAPTURE_TTL_MS = 30 * 60 * 1000;

/** Ephemeral process-wide permission for new requests to write sensitive trace artifacts. */
export class RuntimeTraceCapture {
  private expiresAtMs: number | undefined;

  constructor(
    private readonly ttlMs = RUNTIME_TRACE_CAPTURE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  enabled(): boolean {
    return this.currentExpiry() !== undefined;
  }

  set(enabled: boolean): RuntimeTraceCaptureState {
    this.expiresAtMs = enabled ? this.now() + this.ttlMs : undefined;
    return this.state();
  }

  state(): RuntimeTraceCaptureState {
    const expiresAt = this.currentExpiry();
    return {
      enabled: expiresAt !== undefined,
      ...(expiresAt === undefined ? {} : { expiresAt: new Date(expiresAt).toISOString() }),
      ttlSeconds: Math.floor(this.ttlMs / 1000),
    };
  }

  private currentExpiry(): number | undefined {
    if (this.expiresAtMs !== undefined && this.expiresAtMs <= this.now()) this.expiresAtMs = undefined;
    return this.expiresAtMs;
  }
}
