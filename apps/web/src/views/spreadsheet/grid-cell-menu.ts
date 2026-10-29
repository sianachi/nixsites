import { type CellRef } from '@nix/sheet';
import { type MenuEntry } from '@nix/ui';

import { type Item, type PropertyDefinition } from '../../collections/core/container-model';
import { type SelectionAction } from '../../collections/sheet/selection';
import { type PlanVerb } from './grid-geometry';
import { cellText, clearPlan, type SpreadsheetColumn, type WritePlan } from './grid-model';
import { canEditProperty } from './use-grid-edit';

/** The right-click menu for the cell at `ref`: open the row, edit the cell, clear it. */
export function gridCellMenuItems(
  ref: CellRef,
  items: readonly Item[],
  columns: readonly SpreadsheetColumn[],
  properties: readonly PropertyDefinition[],
  actions: {
    readonly onOpen: (itemId: string) => void;
    readonly commitDraft: (then: 'stay') => boolean;
    readonly dispatch: (action: SelectionAction) => void;
    readonly beginEdit: (source: 'open', draft: string, ref: CellRef) => void;
    readonly applyPlan: (plan: WritePlan, verb: PlanVerb) => void;
  },
): readonly MenuEntry[] {
  const { onOpen, commitDraft, dispatch, beginEdit, applyPlan } = actions;
  const item = items[ref.row];
  const column = columns[ref.col];
  if (item === undefined || column === undefined) return [];
  return [
    {
      label: `Open ${item.title || 'Untitled'}`,
      onSelect: () => {
        onOpen(item.id);
      },
    },
    {
      label: `Edit ${column.label}`,
      disabled: !canEditProperty(properties.find((property) => property.key === column.key)),
      onSelect: () => {
        if (!commitDraft('stay')) return;
        dispatch({ type: 'moveTo', ref, extend: false });
        beginEdit('open', cellText(item, column), ref);
      },
    },
    {
      label: `Clear ${column.label}`,
      disabled: !column.editable || cellText(item, column).length === 0,
      onSelect: () => {
        if (!commitDraft('stay')) return;
        dispatch({ type: 'moveTo', ref, extend: false });
        applyPlan(
          clearPlan(
            { startRow: ref.row, endRow: ref.row, startCol: ref.col, endCol: ref.col },
            items,
            columns,
          ),
          'cleared',
        );
      },
    },
  ];
}
