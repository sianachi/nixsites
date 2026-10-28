/** Runs `run` over `items` with at most `limit` in flight; results keep the items' order. */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  signal: AbortSignal,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  async function worker(): Promise<void> {
    while (!failed) {
      signal.throwIfAborted();
      const index = next++;
      const item = items[index];
      if (item === undefined) return;
      try {
        results[index] = await run(item, index);
      } catch (error) {
        // One failure stops the others from starting more work, as the sequential loop stopped.
        failed = true;
        throw error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
