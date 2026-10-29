import { cellKey, type CellRef } from '@nix/sheet';
import { type MenuEntry } from '@nix/ui';

import { type SelectionAction } from '../../collections/sheet/selection';
import { type SheetData } from './use-sheet';

/** The right-click menu for the cell at `ref`: edit, clear, undo and redo. */
export function sheetCellMenuItems(
  sheet: SheetData,
  ref: CellRef,
  commitDraft: (then: 'stay') => void,
  dispatch: (action: SelectionAction) => void,
  beginEdit: (source: 'open', draft: string) => void,
): readonly MenuEntry[] {
  const key = cellKey(ref);
  return [
    {
      label: `Edit ${key}`,
      onSelect: () => {
        commitDraft('stay');
        dispatch({ type: 'moveTo', ref, extend: false });
        beginEdit('open', sheet.cells.get(key) ?? '');
      },
    },
    {
      label: `Clear ${key}`,
      disabled: !sheet.cells.has(key),
      onSelect: () => {
        commitDraft('stay');
        sheet.setCell(ref, '');
        dispatch({ type: 'moveTo', ref, extend: false });
      },
    },
    { label: 'Undo', onSelect: sheet.undo },
    { label: 'Redo', onSelect: sheet.redo },
  ];
}
