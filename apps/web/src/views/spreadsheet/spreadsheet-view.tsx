import { type ReactNode } from 'react';

import { type View } from '../../collections/core/container-model';
import { CreateItemControl } from '../core/create-item-control';
import type { ContainerData } from '../../collections/core/use-container';
import { drawable, useViewChrome } from '../core/view-chrome';
import { useViewState, type SortDirection } from '../../collections/core/view-state';
import { suggestSourceOf } from '../suggest/suggest-source';
import { resolveColumns } from './grid-model';
import { SpreadsheetGrid } from './spreadsheet-grid';

/**
 * The spreadsheet view: a container's children as a windowed, range-selectable grid.
 *
 * The *view* axis of the two-axis rule: rows are children, cells are property values, and every
 * edit is a property write on an item - visible in every other view, and to everybody else. The
 * spreadsheet *body* is the other axis (free cells, formulas, a shared document); the two share
 * the windowing arithmetic, the selection reducer, the keyboard ladder (`grid-keys.ts`) and the
 * clipboard format, and nothing else.
 *
 * **The keyboard model is the body's, kept identical through the shared ladder** (goal 3.8 names
 * it as the reference): focus stays on the scroller with `aria-activedescendant` naming the active
 * cell - a roving tabindex breaks the moment windowing unmounts the focused cell - arrows move,
 * Shift extends, typing replaces, Enter edits (or opens, on a title), Tab moves with Escape
 * releasing it.
 *
 * Cells stay windowed; only the active cell mounts an editor. Text typing uses the same coercion
 * as paste and fill, while property choices use the shared picker rather than free-form text.
 */

export interface SpreadsheetViewProps {
  readonly container: ContainerData;
  readonly view: View;
  readonly onOpen: (itemId: string) => void;
}

export function SpreadsheetView(props: SpreadsheetViewProps): ReactNode {
  const { container, view, onOpen } = props;
  const viewState = useViewState();

  // The URL wins, the stored view is the starting point - the list's rule, verbatim.
  const sortBy = viewState.sortBy ?? view.sortBy ?? null;
  const direction: SortDirection =
    viewState.sortBy !== null
      ? viewState.direction
      : view.sortDescending
        ? 'descending'
        : 'ascending';

  const chrome = useViewChrome({
    container,
    viewState,
    subject: 'this spreadsheet',
    // Like the list: nothing configured is still drawable, because the schema is the fallback and
    // titles exist with no schema at all.
    drawable: drawable(null),
    emptyTitle: 'Nothing in here yet',
    emptyDetail: 'Items added to this one appear here as rows.',
    emptyAction: <CreateItemControl label="Add an item" onCreate={container.create} />,
    filtered: (total) => ({
      title: 'No items match the filters',
      detail:
        total === 1
          ? 'The one item in here is hidden by the current filters.'
          : `All ${String(total)} items in here are hidden by the current filters.`,
    }),
    savedRules: view.filters,
    view,
    sortBy,
    descending: direction === 'descending',
  });

  if (chrome.kind === 'chrome') {
    return chrome.node;
  }

  return (
    <div className="min-w-0 max-w-full">
      {chrome.notice}

      <SpreadsheetGrid
        items={chrome.items}
        columns={resolveColumns(view, container.schema)}
        properties={container.schema?.properties ?? []}
        sortBy={sortBy}
        direction={direction}
        onSort={(key, next) => {
          viewState.setSort(key, next);
        }}
        onWrite={(itemId, bag) => container.setProperties(itemId, bag)}
        onWriteMany={(writes) => container.setPropertiesMany(writes)}
        onOpen={onOpen}
        viewId={view.id}
      />

      <CreateItemControl
        label="Add an item"
        onCreate={container.create}
        suggest={suggestSourceOf(container, onOpen)}
        className="mt-2"
      />
    </div>
  );
}
