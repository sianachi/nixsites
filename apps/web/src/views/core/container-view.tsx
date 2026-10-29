import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Text } from '@nix/ui';
import {
  useCoarsePointer,
  useNarrowViewport,
  useRoomForAnotherPane,
} from '@nix/web-foundation/layout/viewport';
import { useOptionalItemCommands } from '../../collections/items/item-commands-context';
import { useItemDialog } from '@nix/web-foundation/lib/item-dialog-context';

import { EmptyPanel, ErrorPanel } from '@nix/web-foundation/components/states/status-panels';
import type { View } from '../../collections/core/container-model';
import type { ContainerData } from '../../collections/core/use-container';
import { VIEW_GUTTER } from '../../collections/core/view-gutter';
import { ClickSelectsContext } from '../../collections/core/item-open-click';
import { ItemSelectionContext } from '../../collections/core/item-selection-context';
import { resolveOpenMode } from '../../collections/core/open-policy';
import { SelectionBar } from './selection-bar';
import { useItemSelection, useSelectionShortcuts } from '../../collections/core/use-item-selection';
import { capabilitiesOf, DRAG_EFFECT_COPY } from '../../collections/core/view-capabilities';
import { findViewKind } from './view-kinds';
import { ViewItemVisibility } from './view-item-visibility';
import { ViewTools, type ViewToolsPlacement } from './view-tools';
import { useViewState } from '../../collections/core/view-state';

/**
 * An item's children, drawn the way the chosen view says.
 *
 * Only the contents. The switcher, the configuration buttons and the item's own heading belong to
 * the screen around this, because that screen also has to offer the item's *body* - and a control
 * that chose between the body and a view could not live inside the thing it chooses.
 */

export interface ContainerViewProps {
  readonly container: ContainerData;

  /** The chosen view, or null when the item offers none. */
  readonly view: View | null;

  readonly onOpen: (itemId: string) => void;

  /** Opens in another pane, when the screen around this view offers one. */
  readonly onOpenBeside?: ((itemId: string) => void) | undefined;

  /** Opens as a pinned document tab, for views set to open in a new tab. */
  readonly onOpenPinned?: ((itemId: string) => void) | undefined;

  /** The screen around this view draws its search and options in the view switcher's row. */
  readonly toolsInRow?: boolean;
}

export function ContainerView({
  container,
  view,
  onOpen,
  onOpenBeside,
  onOpenPinned,
  toolsInRow = false,
}: ContainerViewProps): ReactNode {
  const openDialog = useItemDialog();
  const narrow = useNarrowViewport();
  const coarse = useCoarsePointer();
  const roomForPane = useRoomForAnotherPane();
  // One policy decides how an activated row opens; see open-policy.ts.
  const mode = resolveOpenMode({
    view,
    narrow,
    canOpenBeside: roomForPane && onOpenBeside !== undefined,
  });
  // A mode whose host is absent (`tab` inside a dialog, say) falls back to `onOpen`.
  const open = {
    page: onOpen,
    dialog: openDialog ?? onOpen,
    beside: onOpenBeside ?? onOpen,
    tab: onOpenPinned ?? onOpen,
    // Not what a click does (it selects); the double-click, Enter and menu Open target.
    none: onOpen,
  }[mode];
  const [grid, setGrid] = useState(false);

  // One selection for whatever the view draws (requirement 7). Rows that leave the container -
  // moved, deleted, filtered by somebody else - leave the selection with them.
  const capabilities = capabilitiesOf(view?.kind ?? 'list');
  const selection = useItemSelection();
  const commands = useOptionalItemCommands();
  const childIds = container.children.map((child) => child.id);
  const childKey = childIds.join('\u0000');
  useEffect(() => {
    selection.prune(childKey.length === 0 ? [] : childKey.split('\u0000'));
    // `prune` is stable; the join is what changes when the children do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [childKey]);
  const selecting = capabilities.select && !container.locked;
  // What the view says it draws, for Select all and Cmd/Ctrl-A: filters live in the view, so it reports.
  const [shown, setShown] = useState<readonly string[]>([]);
  const [trayActions, setTrayActions] = useState<ReactNode>(null);
  const show = useCallback((ids: readonly string[]): void => {
    setShown((current) =>
      current.length === ids.length && current.every((id, index) => id === ids[index])
        ? current
        : ids,
    );
  }, []);
  const paneRef = useRef<HTMLDivElement>(null);
  // Identity matters: the shortcut listener re-attaches whenever this changes.
  const shownIds = useCallback(() => shown, [shown]);
  useSelectionShortcuts(paneRef, selection, shownIds);
  const allShownSelected = shown.every((id) => selection.selected.has(id));
  const dropDeleted = (deleted: readonly string[]): void => {
    const gone = new Set(deleted);
    selection.setAll([...selection.selected].filter((id) => !gone.has(id)));
  };
  const selectionBar = selecting ? (
    <SelectionBar
      count={selection.selected.size}
      shownCount={allShownSelected ? 0 : shown.length}
      onSelectAll={() => {
        selection.setAll(shown);
      }}
      onMove={
        commands === null || !capabilities.move
          ? undefined
          : () => {
              commands.moveItems([...selection.selected]);
            }
      }
      onDelete={
        commands === null || !capabilities.delete
          ? undefined
          : () => {
              void commands
                .deleteItems(
                  container.children
                    .filter((item) => selection.selected.has(item.id))
                    .map((item) => ({ ...item, seq: Number(item.seq) })),
                )
                .then(dropDeleted);
            }
      }
      onClear={selection.clear}
    >
      {trayActions}
    </SelectionBar>
  ) : null;
  // What a drop does here, said before it happens rather than discovered afterwards.
  const dragHint =
    capabilities.drag === null || container.locked || coarse ? null : (
      <Text as="p" variant="caption" tone="muted">
        {DRAG_EFFECT_COPY[capabilities.drag]}
      </Text>
    );
  const selectionValue = {
    selected: selection.selected,
    toggle: selection.toggle,
    capabilities,
    shown,
    show,
    openBeside: roomForPane ? onOpenBeside : undefined,
    setTrayActions,
  };
  const tools = toolsInRow ? null : (
    <ContainerViewTools container={container} view={view} placement="inline" />
  );
  if (narrow && view?.kind === 'sheet')
    return (
      <div className={VIEW_GUTTER}>
        {tools}
        <Button
          variant="ghost"
          aria-pressed={grid}
          onClick={() => {
            setGrid(!grid);
          }}
        >
          {grid ? 'Browse records' : 'Show spreadsheet grid'}
        </Button>
        {grid ? (
          <ViewItemVisibility container={container} view={view}>
            {(visible) => renderContent(visible, view, open)}
          </ViewItemVisibility>
        ) : (
          <ViewItemVisibility container={container} view={view}>
            {(visible) => findViewKind('list')?.render({ container: visible, view, onOpen: open })}
          </ViewItemVisibility>
        )}
      </div>
    );
  return (
    <ClickSelectsContext value={mode === 'none'}>
      <ItemSelectionContext value={selecting ? selectionValue : null}>
        <div ref={paneRef} className={VIEW_GUTTER}>
          {tools}
          {dragHint}
          <ViewItemVisibility container={container} view={view}>
            {(visible) => renderContent(visible, view, open)}
          </ViewItemVisibility>
          {selectionBar}
        </div>
      </ItemSelectionContext>
    </ClickSelectsContext>
  );
}

/**
 * Search, sort and saved filters for a view. Drawn inline above the contents, or - with
 * `placement="row"` - handed to the view switcher so they share its row.
 */
export function ContainerViewTools({
  container,
  view,
  placement,
}: {
  readonly container: ContainerData;
  readonly view: View | null;
  readonly placement: ViewToolsPlacement;
}): ReactNode {
  const viewState = useViewState();
  const descriptor = view === null ? null : findViewKind(view.kind);
  if (
    container.status !== 'ready' ||
    container.locked ||
    !(view === null || descriptor?.appliesSavedFilters === true || view.kind === 'query')
  ) {
    return null;
  }
  return (
    <ViewTools
      key={`${container.itemId ?? 'root'}:${view?.id ?? 'default'}`}
      placement={placement}
      view={view}
      schema={container.schema?.properties ?? []}
      viewState={viewState}
      onSave={async (filters) => {
        const stored = container.views?.views ?? [];
        if (view === null || !stored.some((candidate) => candidate.id === view.id)) {
          return 'This view is no longer available. Reload it before saving filters.';
        }
        return container.setViews(
          stored.map((candidate) =>
            candidate.id === view.id ? { ...candidate, filters: [...filters] } : candidate,
          ),
        );
      }}
    />
  );
}

function renderContent(
  container: ContainerData,
  view: View | null,
  onOpen: (itemId: string) => void,
): ReactNode {
  // Before any view: a lock withholds the children every view draws from, and a view drawn over
  // nothing would read as an empty item.
  if (container.locked) {
    return (
      <EmptyPanel
        title="This is locked"
        detail="What is inside is hidden until you unlock it with its password."
      />
    );
  }

  // No views configured at all is not a broken state: it is every item nobody has set one up on,
  // which is most of them. A list is the sensible default because it needs no configuration - it
  // has titles to show even with no schema.
  if (view === null) {
    return findViewKind('list')?.renderUnconfigured?.({ container, onOpen });
  }

  // The registry decides, rather than a switch with a default arm. That arm used to catch 'list'
  // and therefore also caught anything new, so a kind added to the type but not to the dispatch
  // rendered as a list and looked like it had worked.
  const descriptor = findViewKind(view.kind);

  if (descriptor === null) {
    // The shared error panel rather than a local shape of this file's own. A view that cannot be
    // drawn is the same fact whether the kind is unknown to this build or the configuration has
    // drifted, and the two used to be drawn differently for no reason but where they were written.
    return (
      <ErrorPanel
        title="This build cannot render that view"
        detail={`"${view.name}" is a ${view.kind} view, which this version of Nix does not know how to draw. It has not been changed or removed.`}
      />
    );
  }

  return descriptor.render({ container, view, onOpen });
}
