export interface TraceCaptureAvailability {
  loaded: boolean;
  known: boolean;
  rawBodies: boolean;
}

/** Prevent a later runtime grant from silently resuming a chat's stale capture selector. */
export function shouldClearThreadTrace(
  admin: boolean,
  availability: TraceCaptureAvailability,
  threadTraceEnabled: boolean,
): boolean {
  return admin && availability.loaded && availability.known && !availability.rawBodies && threadTraceEnabled;
}
