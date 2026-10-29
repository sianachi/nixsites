import { cn, focusRing, type TableColumn } from '@nix/ui';
import type { ReactNode } from 'react';

import {
  isKnownPropertyType,
  type PropertyInputDensity,
} from '@nix/web-collections/properties/property-input';
import { TITLE_COLUMN_KEY, resolveConfiguredColumns } from '@nix/web-collections/core/columns';
import {
  readPropertyText,
  type EffectiveSchema,
  type Item,
  type PropertyDefinition,
  type PropertyValue,
  type View,
} from '@nix/web-collections/core/container-model';
import type { rowGestures } from '@nix/web-collections/core/use-item-selection';
import { ListCell } from './list-cell';

/** The selection column's key; never a property, so it cannot collide with one. */
export const SELECT_COLUMN_KEY = '\u0000select';

/** A table column that, when it edits a known property, also names it so a phone row can read it. */
export type ListColumn = TableColumn<Item> & {
  readonly property?: PropertyDefinition;
  /** The same control at card density, for a popover on a phone where a table cell is too tight. */
  readonly cardCell?: (item: Item) => ReactNode;
};

export type RowGestures = ReturnType<typeof rowGestures>;

/**
 * The columns, in order: the title first, then the properties.
 *
 * The title leads unconditionally and is the row header, because it is how a person names the row
 * and how a screen reader announces which row a cell belongs to. A view that lists its own columns
 * is choosing which *properties* to show and in what order - it is not choosing whether the row
 * says what it is - so a `title` entry in that list is dropped rather than rendered twice.
 *
 * A configured column whose property is not in the schema still gets a column, headed by its key.
 * The alternative is dropping it silently, which turns a renamed property into a column that
 * vanished for no stated reason; a column of blanks under an unfamiliar heading at least says
 * where to look.
 */
export function buildColumns(
  view: View | null,
  schema: EffectiveSchema | null,
  gestures: (item: Item) => RowGestures,
  write: (itemId: string, key: string, value: PropertyValue) => Promise<string | null>,
  refusals: CellRefusalStore,
): readonly ListColumn[] {
  const { keys, definitions } = resolveConfiguredColumns(view, schema);

  return [
    {
      key: TITLE_COLUMN_KEY,
      header: 'Title',
      rowHeader: true,
      sortable: true,
      cell: (item) => (
        // Read-only, unlike every other column, and deliberately: renaming an item goes through the
        // tree rather than through a property write, and the row header has to stay the row's
        // primary affordance - a text box here would put an edit where a person expects a link.
        //
        // A button in the cell rather than a click handler on the row: a clickable <tr> cannot be
        // reached by a keyboard and announces nothing to a screen reader, so the affordance goes
        // on the one thing in the row that already names the destination.
        <button
          type="button"
          {...gestures(item)}
          className={cn(
            'line-clamp-2 w-full cursor-default text-left hover:text-accent-text pointer-coarse:min-h-(--control-lg)',
            focusRing,
          )}
        >
          {item.title.length > 0 ? item.title : 'Untitled'}
        </button>
      ),
    },
    ...keys.map((key): ListColumn => {
      const definition = definitions.get(key);

      return {
        key,
        header: definition?.label ?? key,
        sortable: true,
        cell: (item) => renderProperty(item, key, definition, write, refusals),
        ...(definition !== undefined && isKnownPropertyType(definition.type)
          ? {
              property: definition,
              cardCell: (item: Item) =>
                renderProperty(item, key, definition, write, refusals, 'card'),
            }
          : {}),

        // Numbers read right-aligned so their digits line up; everything else keeps the table's
        // own default rather than restating it.
        ...(definition?.type === 'number' ? { align: 'end' as const } : {}),
      };
    }),
  ];
}

/**
 * One property cell: a control where this build knows the property type, and the stored value where
 * it does not.
 *
 * The unknown case reads rather than edits, and it renders as bare text rather than through the
 * read-only floor `PropertyInput` falls back to. That floor explains itself in a sentence, and a
 * sentence inside a table cell becomes part of the cell's accessible name - so the cell holding
 * "four of five" would announce a paragraph about property types instead of the value.
 *
 * A column the schema does not describe at all has no type to dispatch on and no label to name a
 * control with, so it reads too.
 */
function renderProperty(
  item: Item,
  key: string,
  definition: PropertyDefinition | undefined,
  write: (itemId: string, key: string, value: PropertyValue) => Promise<string | null>,
  refusals: CellRefusalStore,
  density?: PropertyInputDensity,
): ReactNode {
  if (definition === undefined || !isKnownPropertyType(definition.type)) {
    return readPropertyText(item, key);
  }

  return (
    <ListCell
      item={item}
      property={definition}
      onWrite={(value) => write(item.id, key, value)}
      {...(density === undefined ? {} : { density })}
      refusal={refusals.read(item.id, key)}
      onRefusalChange={(refusal) => {
        refusals.write(item.id, key, refusal);
      }}
    />
  );
}

export interface CellRefusalStore {
  readonly read: (itemId: string, key: string) => string | null;
  readonly write: (itemId: string, key: string, refusal: string | null) => void;
}

export function cellRefusalKey(itemId: string, key: string): string {
  return `${itemId}\u0000${key}`;
}
