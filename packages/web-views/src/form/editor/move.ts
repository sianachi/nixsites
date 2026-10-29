export function move<T>(values: readonly T[], index: number, by: -1 | 1): T[] {
  const next = [...values];
  const target = index + by;
  const current = next[index];
  const replacement = next[target];
  if (current === undefined || replacement === undefined) return next;
  next[index] = replacement;
  next[target] = current;
  return next;
}
