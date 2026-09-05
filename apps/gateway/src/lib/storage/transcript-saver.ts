/** Keep saves ordered within a tab. Never advance past a failed or ambiguous write. */
export function createTranscriptSaver<T>(
  initialRevision: number,
  save: (snapshot: T, expectedRevision: number) => Promise<number>,
) {
  let revision = initialRevision;
  let tail = Promise.resolve();
  return (snapshot: T): Promise<void> => {
    // Freeze the snapshot now: streamed message parts may change while an earlier save is pending.
    const captured = structuredClone(snapshot);
    tail = tail.then(async () => {
      revision = await save(captured, revision);
    });
    return tail;
  };
}
