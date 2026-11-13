import {
  Icon,
  Menu,
  Text,
  focusRing,
  inkWashStates,
  type ContextMenuTargetProps,
  type MenuEntry,
} from '@nix/ui';
import {
  ChevronDown,
  ChevronRight,
  FolderLock,
  GripVertical,
  MoreHorizontal,
  Pin,
  Shield,
} from 'lucide-react';
import {
  useId,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useBookmarksStore, useIsKept } from '@nix/web-collections/items/use-bookmarks';
import type { rowGestures } from '@nix/web-collections/core/use-item-selection';
import type { TreeItem } from '@nix/web-collections/items/use-workspace-tree';
import type { ItemLandmarks } from '@nix/web-foundation/lib/item-landmarks';
import { ItemLandmarkIcon } from './item-landmark-dialog';
import { ROW_INDENT, indentAt, type DropZone } from './tree-geometry';

interface TreeRowProps {
  readonly contextTarget: ContextMenuTargetProps;
  readonly dragProps: HTMLAttributes<HTMLDivElement>;
  readonly item: TreeItem;
  readonly depth: number;
  readonly landmark: ItemLandmarks[string] | undefined;
  readonly selected: boolean;
  readonly inSelection: boolean;
  readonly zone: DropZone | null;
  readonly dropping: boolean;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly onToggleExpanded: () => void;
  readonly gestures: ReturnType<typeof rowGestures>;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  readonly openButtonRef: RefObject<HTMLButtonElement | null>;
  readonly onOpenPinned: (itemId: string) => void;
  /** `data-flash` from `useFlash`: tints the row once after a move or a create. */
  readonly flashProps: { readonly 'data-flash'?: 'a' | 'b' };
  readonly contextItems: () => MenuEntry[];
}

/** The visible row of a tree node: expand control, title button, drag grip and actions menu. */
export function TreeRow(props: TreeRowProps): ReactNode {
  const {
    contextTarget,
    dragProps,
    item,
    depth,
    landmark,
    selected,
    inSelection,
    zone,
    dropping,
    expandable,
    expanded,
    onToggleExpanded,
    gestures,
    onKeyDown,
    openButtonRef,
    onOpenPinned,
    flashProps,
    contextItems,
  } = props;
  const kept = useIsKept(item.id);
  const bookmarkDescriptionId = useId();
  const bookmarkError = useBookmarksStore((state) =>
    state.actionError?.itemId === item.id ? state.actionError.message : null,
  );
  const actionLabel = `Actions for ${item.title || 'Untitled'}`;
  const deleteProtected = item.noDelete === true;
  const managed = item.managedBy !== undefined && item.managedBy !== null;

  return (
    <>
      <div
        {...contextTarget}
        {...dragProps}
        {...flashProps}
        className={[
          'group relative flex cursor-grab items-center gap-1 rounded-md pr-1 active:cursor-grabbing',
          indentAt(ROW_INDENT, depth),
          selected ? 'bg-accent/14' : inSelection ? 'bg-accent/10' : 'hover:bg-accent/8',
          dropping && zone === 'inside' ? 'outline-2 -outline-offset-2 outline-accent' : '',
        ].join(' ')}
      >
        {/* A line where the item would land, rather than an outline round the row it would land
            beside. An outline says "into this"; a line between two rows says "between them", which
            is the thing being chosen. */}
        {dropping && zone !== 'inside' ? (
          <span
            aria-hidden="true"
            className={[
              'pointer-events-none absolute inset-x-0 h-0.5 bg-accent',
              zone === 'before' ? 'top-0' : 'bottom-0',
            ].join(' ')}
          />
        ) : null}

        {/* `max-sm:size-(--control-sm)` on both the button and its placeholder, narrow-scoped:
            below `sm` this is a touch target and 20px (`size-5`) is under WCAG 2.5.8's 24px floor,
            but the two have to grow together or a row without an expand control would sit at a
            different gutter width than one with it.

            `pointer-coarse:size-(--control-sm) in-data-[layout=touch]:size-(--control-md)!` rides alongside it: `group-hover:*` only applies
            under `@media(hover:hover)` (Tailwind v4's `pointer-coarse:` variant maps to
            `@media(pointer:coarse)`), so a touch-capable device *above* `sm` - an iPad in portrait,
            say - would otherwise get neither the hover reveal nor the `max-sm:` override, leaving
            it unreachable rather than merely small. */}
        {expandable ? (
          <button
            type="button"
            data-context-menu-ignore
            aria-label={expanded ? `Collapse ${item.title}` : `Expand ${item.title}`}
            onClick={onToggleExpanded}
            className="flex size-5 max-sm:size-(--control-sm) pointer-coarse:size-(--control-sm) in-data-[layout=touch]:size-(--control-md)! items-center justify-center text-muted hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
          >
            <Icon icon={expanded ? ChevronDown : ChevronRight} size="sm" />
          </button>
        ) : (
          <span
            aria-hidden="true"
            className="size-5 max-sm:size-(--control-sm) pointer-coarse:size-(--control-sm) in-data-[layout=touch]:size-(--control-md)!"
          />
        )}

        <button
          ref={openButtonRef}
          type="button"
          onClick={gestures.onClick}
          onDoubleClick={() => {
            onOpenPinned(item.id);
          }}
          // On the row's own control rather than on the wrapper: this is the element that takes
          // focus, so it is the one whose keys mean anything, and a div carrying key handlers is a
          // control that only looks like one.
          onKeyDown={onKeyDown}
          onKeyUp={gestures.onKeyUp}
          aria-describedby={kept ? bookmarkDescriptionId : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          {kept ? (
            <>
              <Icon icon={Pin} size="sm" className="shrink-0 text-accent-text" />
              <span id={bookmarkDescriptionId} hidden>
                Bookmarked
              </span>
            </>
          ) : (
            <ItemLandmarkIcon landmark={landmark} item={item} />
          )}
          <Text as="span" variant="body" truncate>
            {item.title || 'Untitled'}
          </Text>
          {deleteProtected ? (
            <>
              <Icon icon={Shield} size="sm" className="shrink-0 text-muted" />
              <span className="sr-only">
                {managed ? 'Part of a linked calendar' : 'Protected from deletion'}
              </span>
            </>
          ) : null}
          {item.noChildren === true ? (
            <>
              <Icon icon={FolderLock} size="sm" className="shrink-0 text-muted" />
              <span className="sr-only">Does not accept new children</span>
            </>
          ) : null}
        </button>

        {/* The drag handle's picture: the whole row drags, this says so. Shown on hover and focus, and
            always on touch where there is no hover; "Move to..." does the same without dragging. */}
        <span
          aria-hidden="true"
          className="pointer-events-none flex shrink-0 text-muted opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
        >
          <Icon icon={GripVertical} size="sm" />
        </span>

        <Menu label={actionLabel} items={contextItems()}>
          {(trigger) => (
            <button
              {...trigger}
              data-context-menu-ignore
              aria-label={actionLabel}
              title={actionLabel}
              className={`flex size-(--control-sm) shrink-0 items-center justify-center rounded-sm text-muted hover:text-foreground opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto aria-expanded:opacity-100 aria-expanded:pointer-events-auto max-sm:size-(--control-lg) max-sm:opacity-100 max-sm:pointer-events-auto any-pointer-coarse:size-(--control-lg) any-pointer-coarse:opacity-100 any-pointer-coarse:pointer-events-auto in-data-[layout=touch]:size-(--control-lg)! in-data-[layout=touch]:opacity-100 in-data-[layout=touch]:pointer-events-auto ${inkWashStates} ${focusRing}`}
            >
              <Icon icon={MoreHorizontal} size="sm" />
            </button>
          )}
        </Menu>
      </div>
      {bookmarkError === null ? null : (
        <Text variant="note" role="alert" tone="accent" className={indentAt(ROW_INDENT, depth)}>
          {bookmarkError}
        </Text>
      )}
    </>
  );
}
