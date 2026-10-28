import { type CellRange } from '@nix/sheet';
import { useState } from 'react';

import { useViewSuggestionPreference } from '@nix/web-foundation/lib/suggestion-preferences';
import { type Item } from '../core/container-model';
import { seriesFillOffer, type SpreadsheetColumn } from './grid-model';

/**
 * The unprompted offer to continue a pattern: detection only - the seed, its step and a short
 * preview - and only when every target cell is empty, so the button can never overwrite. Cheap
 * enough to derive on each render (a walk down the selected columns that stops at the first
 * filled target), so it carries no memo and no dependency on the item list's identity; the plan
 * itself is built only when somebody asks for it, in `fillSeries`.
 */
export function useFillOffer(
  range: CellRange,
  navigating: boolean,
  items: readonly Item[],
  columns: readonly SpreadsheetColumn[],
): {
  readonly fillOffer: ReturnType<typeof seriesFillOffer>;
  readonly patternedColumn:
    NonNullable<ReturnType<typeof seriesFillOffer>>['columns'][number] | null;
  readonly dismiss: () => void;
} {
  const viewSuggestions = useViewSuggestionPreference((state) => state.setting);
  const rangeKey = `${String(range.startRow)}:${String(range.startCol)}:${String(range.endRow)}:${String(range.endCol)}`;

  // Which selection's offer was dismissed. Keyed by the range so selecting somewhere else offers
  // again; a dismissal is about this guess, not about the feature.
  const [dismissedFill, setDismissedFill] = useState<string | null>(null);
  const fillOffer =
    viewSuggestions === 'on' &&
    navigating &&
    range.endRow > range.startRow &&
    dismissedFill !== rangeKey
      ? seriesFillOffer(range, items, columns)
      : null;
  const patternedColumn =
    fillOffer?.patterned === true
      ? (fillOffer.columns.find((fill) => fill.kind !== 'repeat') ?? null)
      : null;
  return {
    fillOffer,
    patternedColumn,
    dismiss: () => {
      setDismissedFill(rangeKey);
    },
  };
}
