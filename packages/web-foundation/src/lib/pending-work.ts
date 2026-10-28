const pending = new Set<() => Promise<void>>();
/** An update may reload only after every mounted editor confirms its pending writes. */
export function registerPendingWork(flush: () => Promise<void>): () => void {
  pending.add(flush);
  return () => {
    pending.delete(flush);
  };
}
export async function flushPendingWork(): Promise<void> {
  await Promise.all([...pending].map((flush) => flush()));
}
