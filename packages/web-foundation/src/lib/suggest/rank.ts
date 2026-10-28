/**
 * Choices in the order somebody usually reaches for them, without losing the order they were given.
 *
 * Options with a remembered score come first, strongest first; everything never picked keeps the
 * order the caller supplied (a schema's declared order, say), after them. Ties between scored
 * options also fall back to that order, so two equally-used values do not swap places from one
 * render to the next. Pure: the scores come from `frecency.ts` or anywhere else.
 */
export function rankByScore<T>(
  options: readonly T[],
  scores: ReadonlyMap<string, number>,
  keyOf: (option: T) => string,
): readonly T[] {
  if (scores.size === 0) {
    return options;
  }
  return options
    .map((option, index) => ({ option, index, score: scores.get(keyOf(option)) ?? 0 }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.option);
}
