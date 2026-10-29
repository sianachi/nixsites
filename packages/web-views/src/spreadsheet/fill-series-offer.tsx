import type { ReactNode } from 'react';

import { SuggestionAction, SuggestionHint } from '../suggest/suggestion-hint';

/**
 * The spreadsheet's offer to continue a pattern down the selection.
 *
 * Shown when the selected cells start with a recognisable series - `Week 1, Week 2`, `10, 20`, a
 * date every Monday - and only empty cells below it to continue into: an offer never overwrites,
 * while the shortcut, asked for explicitly, does. It says what it found and what it would write, with the first values spelled out, so the person can see the guess
 * before taking it; nothing is written until they press the button or the shortcut. The fill goes
 * through the grid's ordinary bulk write, so its refusals are reported like a paste's.
 */

export interface FillSeriesOfferProps {
  /** The column the pattern was found in, or the first of several. */
  readonly columnLabel: string;

  /** How the step reads: "+1", "weekly", "monthly". */
  readonly describe: string;

  /**
   * The first values that would be written, enough to recognise the pattern. When `rows` is larger
   * the sentence says the series goes on.
   */
  readonly preview: readonly string[];

  /** Rows that would receive a value. */
  readonly rows: number;

  /** Further columns that would also be filled, if the selection spans several. */
  readonly otherColumns: number;

  /** The keyboard spelling of the same action, named in the sentence so it can be learned here. */
  readonly shortcut: string;

  readonly onFill: () => void;
  readonly onDismiss: () => void;
}

export function FillSeriesOffer(props: FillSeriesOfferProps): ReactNode {
  const { columnLabel, describe, preview, rows, otherColumns, shortcut, onFill, onDismiss } = props;
  const shown = preview.join(', ');
  const more = rows > preview.length ? ', and so on' : '';
  const others =
    otherColumns > 0
      ? `, and ${String(otherColumns)} more ${otherColumns === 1 ? 'column' : 'columns'} the same way`
      : '';
  const label = rows === 1 ? 'Fill 1 row' : `Fill ${String(rows)} rows`;

  return (
    <SuggestionHint
      className="py-1"
      onDismiss={onDismiss}
      dismissLabel="Dismiss the series suggestion"
      actions={
        <SuggestionAction onClick={onFill} label={`${label} with the series in ${columnLabel}`}>
          {label}
        </SuggestionAction>
      }
    >
      {`${columnLabel} continues as a series (${describe}): ${shown}${more}${others}. ${shortcut} does the same.`}
    </SuggestionHint>
  );
}
