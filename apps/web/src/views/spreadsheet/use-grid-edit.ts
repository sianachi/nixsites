import { type CellRef } from '@nix/sheet';
import { useEffect, useRef, useState, type Dispatch, type RefObject } from 'react';

import { isKnownPropertyType } from '../../properties/property-input';
import { TITLE_COLUMN_KEY } from '../core/columns';
import { type Item, type PropertyDefinition } from '../core/container-model';
import { isComputedType } from '../core/property-types';
import type { PlanOutcome, PlanWrite } from '../core/use-container';
import { type GridBounds, type SelectionAction, type SelectionState } from '../sheet/selection';
import { type PlanVerb } from './grid-geometry';
import { cellText, coerceCellText, type SpreadsheetColumn, type WritePlan } from './grid-model';

export function canEditProperty(property: PropertyDefinition | undefined): boolean {
  return (
    property !== undefined && isKnownPropertyType(property.type) && !isComputedType(property.type)
  );
}

export function usesPicker(property: PropertyDefinition | undefined): boolean {
  return property !== undefined && !['text', 'long_text', 'url'].includes(property.type);
}

interface GridEditArgs {
  readonly items: readonly Item[];
  readonly columns: readonly SpreadsheetColumn[];
  readonly properties: readonly PropertyDefinition[];
  readonly selection: SelectionState;
  readonly dispatch: Dispatch<SelectionAction>;
  readonly bounds: GridBounds;
  readonly active: CellRef;
  readonly scrollerRef: RefObject<HTMLDivElement | null>;
  readonly onWrite: (itemId: string, bag: Record<string, unknown>) => Promise<string | null>;
  readonly onWriteMany: (writes: readonly PlanWrite[]) => Promise<PlanOutcome>;
  readonly onOpen: (itemId: string) => void;
}

/** Everything a cell edit, a bulk write or a typed-control edit needs: the grid's write side. */
export interface GridEdit {
  readonly notice: string | null;
  readonly setNotice: (notice: string | null) => void;
  readonly propertyEdit: { itemId: string; propertyKey: string } | null;
  readonly propertyRefusal: string | null;
  readonly propertyPanelRef: RefObject<HTMLDivElement | null>;
  readonly editedItem: Item | undefined;
  readonly editedProperty: PropertyDefinition | undefined;
  readonly closePropertyEdit: (commit?: boolean) => void;
  readonly commitProperty: (item: Item, property: PropertyDefinition, value: unknown) => void;
  readonly applyPlan: (plan: WritePlan, verb: PlanVerb) => void;
  readonly commitDraft: (then: 'down' | 'right' | 'stay') => boolean;
  readonly cancelEdit: () => void;
  readonly beginEdit: (source: 'typing' | 'open', draft: string, ref?: CellRef) => void;
}

export function useGridEdit(args: GridEditArgs): GridEdit {
  const {
    items,
    columns,
    properties,
    selection,
    dispatch,
    bounds,
    active,
    scrollerRef,
    onWrite,
    onWriteMany,
    onOpen,
  } = args;

  /**
   * What the grid last had to say: a refusal, a bulk gesture's outcome, or why a keystroke did
   * nothing. One region rather than per-cell state, because the cells concerned may already be
   * scrolled out of the DOM - the sentence carries the row and column names instead of pointing
   * at a place that may not be mounted. Cleared when the active cell moves, so a stale sentence
   * does not sit under the grid describing an edit from minutes ago.
   */
  const [notice, setNotice] = useState<string | null>(null);
  const [propertyEdit, setPropertyEdit] = useState<{
    itemId: string;
    propertyKey: string;
  } | null>(null);
  const [propertyRefusal, setPropertyRefusal] = useState<string | null>(null);
  const propertyEditRef = useRef(propertyEdit);
  const propertyWriteRef = useRef(0);
  const propertyPanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    propertyEditRef.current = propertyEdit;
  }, [propertyEdit]);

  /**
   * Whether the open edit has already been answered - committed or cancelled. A ref rather than
   * state because the editor's blur fires synchronously inside `scrollerRef.current?.focus()`,
   * before React has re-rendered: the blur handler's closure still says the edit is open, and
   * without this flag the blur would commit the same draft a second time (or commit a draft that
   * Escape had just abandoned). On a click-away it is the blur, fired by the cell handler's
   * `focus()`, that commits first; the cell handler's own `commitDraft` is the call this flag
   * then neutralises.
   */
  const editSettledRef = useRef(false);

  /**
   * Which cell the open edit belongs to, by identity rather than by index. The rows reorder under
   * the grid - an optimistic write in the sorted column moves its own row - and an edit committed
   * against `items[active.row]` after a reorder would write to whichever item slid into that
   * index.
   */
  const editingRef = useRef<{ itemId: string; columnKey: string } | null>(null);

  const editedItem =
    propertyEdit === null ? undefined : items.find((item) => item.id === propertyEdit.itemId);
  const editedProperty = properties.find((property) => property.key === propertyEdit?.propertyKey);
  if (propertyEdit !== null && (editedItem === undefined || editedProperty === undefined)) {
    setPropertyEdit(null);
    setPropertyRefusal(null);
  }

  function closePropertyEdit(commit = true): void {
    if (
      commit &&
      document.activeElement instanceof HTMLElement &&
      propertyPanelRef.current?.contains(document.activeElement)
    ) {
      document.activeElement.blur();
    }
    propertyEditRef.current = null;
    setPropertyEdit(null);
  }

  function say(rowLabel: string, columnLabel: string, sentence: string): void {
    setNotice(`${columnLabel} for ${rowLabel}: ${sentence}`);
  }

  /** The one sentence a bulk gesture gets, whatever mixture of outcomes it had. */
  function applyPlan(plan: WritePlan, verb: PlanVerb): void {
    setNotice(null);

    const writes: PlanWrite[] = plan.writes.map((write) => ({
      itemId: write.item.id,
      label: write.item.title || 'Untitled',
      properties: write.bag,
    }));

    void onWriteMany(writes)
      .then((outcome) => {
        const parts: string[] = [];

        if (outcome.refused.length > 0) {
          const first = outcome.refused[0];
          parts.push(
            `${String(outcome.refused.length)} of ${String(writes.length)} rows were refused` +
              (first === undefined ? '.' : ` - ${first.label}: ${first.reason}`),
          );
        }

        if (plan.unusable > 0) {
          parts.push(
            plan.unusable === 1
              ? `One value could not be ${verb} and was left as it was.`
              : `${String(plan.unusable)} values could not be ${verb} and were left as they were.`,
          );
        }

        const pasted =
          verb === 'taken' && writes.length > 0
            ? `Pasted into ${String(writes.length)} ${writes.length === 1 ? 'row' : 'rows'}.`
            : null;
        setNotice(parts.length === 0 ? pasted : parts.join(' '));
      })
      .catch(() => {
        setNotice('Those changes could not be sent. Check the connection and try again.');
      });
  }

  function commitDraft(then: 'down' | 'right' | 'stay'): boolean {
    if (selection.mode !== 'edit' || editSettledRef.current) {
      return true;
    }

    const editing = editingRef.current;
    const item = items.find((entry) => entry.id === editing?.itemId);
    const column = columns.find((entry) => entry.key === editing?.columnKey);

    if (item === undefined || !column?.editable) {
      editSettledRef.current = true;
      dispatch({ type: 'commit', then, bounds });
      scrollerRef.current?.focus({ preventScroll: true });
      return true;
    }

    if (selection.draft === cellText(item, column)) {
      editSettledRef.current = true;
      dispatch({ type: 'commit', then, bounds });
      scrollerRef.current?.focus({ preventScroll: true });
      return true;
    }

    const coerced = coerceCellText(selection.draft, column.type);

    // Nothing storable: said out loud, and the edit stays open to be corrected rather than being
    // silently dropped - the caller keeps its gesture from closing the editor (see onMouseDown).
    if (!coerced.ok) {
      say(item.title || 'Untitled', column.label, coerced.reason);
      return false;
    }

    setNotice(null);
    editSettledRef.current = true;

    void onWrite(item.id, { [column.key]: coerced.value })
      .then((refusal) => {
        if (refusal !== null) {
          say(item.title || 'Untitled', column.label, refusal);
        }
      })
      .catch(() => {
        say(
          item.title || 'Untitled',
          column.label,
          'that change could not be sent. Check the connection and try again.',
        );
      });

    dispatch({ type: 'commit', then, bounds });
    scrollerRef.current?.focus({ preventScroll: true });
    return true;
  }

  function cancelEdit(): void {
    editSettledRef.current = true;
    dispatch({ type: 'cancel' });
    scrollerRef.current?.focus({ preventScroll: true });
  }

  function beginEdit(source: 'typing' | 'open', draft: string, ref: CellRef = active): void {
    const column = columns[ref.col];
    const item = items[ref.row];
    if (column === undefined || item === undefined) {
      return;
    }

    // The title opens rather than edits: renaming goes through the tree, not a property write,
    // and Enter on a row's name is the grid's way of following it. A keystroke that would have
    // typed over it is answered rather than swallowed - a refusal has to be distinguishable from
    // a no-op.
    if (column.key === TITLE_COLUMN_KEY) {
      if (source === 'open') {
        onOpen(item.id);
      } else {
        setNotice('A row’s name is changed in the item itself - press Enter to open it.');
      }
      return;
    }

    const property = properties.find((entry) => entry.key === column.key);
    if (
      canEditProperty(property) &&
      property !== undefined &&
      usesPicker(property) &&
      (source === 'open' ||
        !['text', 'long_text', 'url', 'number', 'estimate'].includes(property.type))
    ) {
      if (!commitDraft('stay')) return;
      setPropertyRefusal(null);
      const edit = { itemId: item.id, propertyKey: property.key };
      propertyEditRef.current = edit;
      setPropertyEdit(edit);
      return;
    }

    if (!column.editable) {
      say(
        item.title || 'Untitled',
        column.label,
        'this property type cannot be edited here, so the value is shown as stored.',
      );
      return;
    }

    editSettledRef.current = false;
    editingRef.current = { itemId: item.id, columnKey: column.key };
    dispatch({ type: 'startEdit', draft, source });
  }

  /** Writes the popover's value; the refusal shows in the panel only while it is still the open edit. */
  function commitProperty(
    editedItem: Item,
    editedProperty: PropertyDefinition,
    value: unknown,
  ): void {
    const write = ++propertyWriteRef.current;
    setPropertyRefusal(null);
    setNotice(null);
    void onWrite(editedItem.id, { [editedProperty.key]: value })
      .then((refusal) => {
        if (
          propertyWriteRef.current === write &&
          propertyEditRef.current?.itemId === editedItem.id &&
          propertyEditRef.current.propertyKey === editedProperty.key
        )
          setPropertyRefusal(refusal);
        if (refusal !== null) say(editedItem.title || 'Untitled', editedProperty.label, refusal);
      })
      .catch(() => {
        const refusal = 'That change could not be sent. Check the connection and try again.';
        if (
          propertyWriteRef.current === write &&
          propertyEditRef.current?.itemId === editedItem.id &&
          propertyEditRef.current.propertyKey === editedProperty.key
        )
          setPropertyRefusal(refusal);
        say(editedItem.title || 'Untitled', editedProperty.label, refusal);
      });
  }

  return {
    notice,
    setNotice,
    propertyEdit,
    propertyRefusal,
    propertyPanelRef,
    editedItem,
    editedProperty,
    closePropertyEdit,
    commitProperty,
    applyPlan,
    commitDraft,
    cancelEdit,
    beginEdit,
  };
}
