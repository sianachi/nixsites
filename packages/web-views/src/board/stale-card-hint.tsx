import type { ReactNode } from 'react';

import { SuggestionHint } from '../suggest/suggestion-hint';

/**
 * A board card that has gone untouched far longer than its column's cards usually do.
 *
 * **What it can honestly claim, and what it cannot.** The only clock an item carries is
 * `updatedAt`, which moves on *any* change - a column move, a renamed title, an edited property. So
 * "unchanged for 24 days" is exact, and it is a lower bound on how long the card has sat in its
 * column: a card edited yesterday may have been in "Doing" for a month. What the hint cannot do is
 * say where cards usually go next, which is what the board's version of this idea ideally offers -
 * that needs the history of column moves, and no such history reaches the client (Core keeps no
 * per-property transition log for items). So this is the conservative half only: a nudge to look,
 * dismissible, with no write attached. A dismissal is remembered until the card changes (see
 * `board-view.tsx` and `lib/suggestion-dismissals.ts`).
 */

export interface StaleCardHintProps {
  readonly title: string;
  readonly columnLabel: string;
  readonly ageMs: number;
  readonly medianMs: number;
  /** Called when waved away. The caller remembers the dismissal and moves focus to the card. */
  readonly onDismiss: () => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A span as whole days, for a sentence: "a day", "3 days", at least one. The card's own age is
 * rounded down (it is a lower bound already: "no changes in 30 days" stays true), the column's
 * median up - rounding it down would say the column moves faster than it does, and make the card
 * look staler than it is.
 */
function wholeDays(ms: number, round: (days: number) => number): number {
  return Math.max(1, round(ms / DAY_MS));
}

function daysText(days: number): string {
  return days === 1 ? 'a day' : `${String(days)} days`;
}

export function StaleCardHint(props: StaleCardHintProps): ReactNode {
  const { title, columnLabel, ageMs, medianMs, onDismiss } = props;

  return (
    <SuggestionHint
      className="px-0"
      onDismiss={onDismiss}
      dismissLabel={`Dismiss the stale card note on ${title || 'Untitled'}`}
    >
      No changes in {daysText(wholeDays(ageMs, Math.floor))}. Half the cards in {columnLabel}{' '}
      changed in the last{' '}
      {wholeDays(medianMs, Math.ceil) === 1 ? 'day' : daysText(wholeDays(medianMs, Math.ceil))}.
    </SuggestionHint>
  );
}
