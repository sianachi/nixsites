/**
 * The priority scale: four steps, the number stored and the word shown.
 *
 * One table for the control that picks a priority and the display that reads one, so a card and
 * the field that set it can never name a step differently. The server's bound (1 to 4) is the
 * authority on which numbers exist; this is what they mean.
 */
export const PRIORITY_LEVELS = [
  { value: 1, word: 'Urgent' },
  { value: 2, word: 'High' },
  { value: 3, word: 'Normal' },
  { value: 4, word: 'Low' },
] as const;

/** The word for a stored priority, or null for a number off the scale. */
export function priorityWord(value: number): string | null {
  return PRIORITY_LEVELS.find((level) => level.value === value)?.word ?? null;
}

/** How a step reads everywhere: the display and the editor's options share it. */
export function priorityLabel(value: number): string {
  return `P${String(value)} ${priorityWord(value) ?? ''}`.trim();
}
