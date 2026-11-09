import {
  Icon,
  Menu,
  Text,
  focusRing,
  disabledState,
  type ContextMenuTargetProps,
  type MenuEntry,
} from '@nix/ui';
import {
  ChevronDown,
  ChevronRight,
  Columns2,
  FolderLock,
  FolderInput,
  FolderUp,
  GripVertical,
  MoreHorizontal,
  Shield,
  Trash2,
} from 'lucide-react';
import type {
  HTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  RefObject,
} from 'react';
import { useBookmarksStore } from '@nix/web-collections/items/use-bookmarks';
import type { rowGestures } from '@nix/web-collections/core/use-item-selection';
import type { TreeItem } from '@nix/web-collections/items/use-workspace-tree';
import type { ItemLandmarks } from '@nix/web-foundation/lib/item-landmarks';
import { BookmarkButton } from '../bookmarks/bookmark-button';
import { OPEN_BESIDE_REFUSAL_COPY, type OpenBesideRefusal } from '../tabs/use-open-item';
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
  readonly canOpenBeside: boolean;
  readonly besideRefusal: OpenBesideRefusal | null;
  readonly onOpenBeside: (itemId: string) => void;
  readonly onOpenPinned: (itemId: string) => void;
  readonly onDeleteItem: (item: TreeItem) => void;
  readonly moveToRoot: () => void;
  readonly onMoveItem: (itemId: string) => void;
  /** `data-flash` from `useFlash`: tints the row once after a move or a create. */
  readonly flashProps: { readonly 'data-flash'?: 'a' | 'b' };
  readonly contextItems: () => MenuEntry[];
}

/** The visible row of a tree node: expand control, title button, hover actions and the touch menu. */
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
    canOpenBeside,
    besideRefusal,
    onOpenBeside,
    onOpenPinned,
    onDeleteItem,
    moveToRoot,
    onMoveItem,
    flashProps,
    contextItems,
  } = props;
  // A selector rather than the whole store, so a row re-renders when its own answer moves and not
  // when somebody keeps an unrelated item three folders away.
  const keptIds = useBookmarksStore((state) => state.keptIds);
  const deleteProtected = item.noDelete === true;
  const managed = item.managedBy !== undefined && item.managedBy !== null;

  return (
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
        className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <ItemLandmarkIcon landmark={landmark} />
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

      {/* Beside Delete, in the row's own established grammar: revealed on hover, always
            reachable by keyboard - and, below `sm`, always visible and at the 28px control size
            rather than 20px, because touch has no hover to reveal a hidden control with, and a
            control under WCAG 2.5.8's 24px floor is a thumb's width from the row next to it.
            The modifier-click and Alt+Enter above are accelerators for this control rather than
            the whole feature - a gesture only a pointer can make is a feature for only some
            people, and a `title` tooltip is worse than nothing here, because it is read aloud
            after every row while never reaching a touch or keyboard user at all.

            Not rendered at all when the refusal is `'narrow'`: that reason is a fact about this
            viewport, not a transient state of the pane arrangement, and it is true of every row in
            the tree at once. A disabled, ever-present control whose label is a refusal nobody can
            ever act around is worse than no control - on a phone a screen reader would hear it on
            every single row. `'limit'` is the opposite: a temporary state of how many panes happen
            to be open, so it stays visible and disabled, with the explanation, exactly as before. */}
      {besideRefusal === 'narrow' ? null : (
        <button
          type="button"
          disabled={!canOpenBeside}
          data-context-menu-ignore
          aria-label={
            besideRefusal === null
              ? `Open ${item.title || 'Untitled'} beside`
              : `Cannot open ${item.title || 'Untitled'} beside. ${OPEN_BESIDE_REFUSAL_COPY[besideRefusal]}`
          }
          onClick={() => {
            onOpenBeside(item.id);
          }}
          // `opacity-0`, not `invisible`. `visibility: hidden` takes an element out of the tab
          // order entirely, so `focus-visible:visible` can never fire - nothing can focus it in
          // order to un-hide it. The control was pointer-only, which is the objection it exists to
          // answer. Opacity hides it and keeps it reachable.
          //
          // `pointer-events-none` rides along with that same `opacity-0` regardless of viewport
          // width: an element can be hit-tested while fully transparent, so without this a thumb
          // or pointer landing near the row's edge could trigger a control nothing on screen shows
          // it landed on. The three states that raise the opacity back to 100 - hover, focus-visible,
          // group-hover - restore pointer events with it; `max-sm:` does the same unconditionally,
          // since below `sm` this is never hidden in the first place.
          className={`flex size-5 max-sm:size-(--control-sm) items-center justify-center text-muted opacity-0 pointer-events-none hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 max-sm:pointer-events-auto max-sm:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 pointer-coarse:size-(--control-sm) in-data-[layout=touch]:size-(--control-md)! sm:pointer-coarse:hidden ${disabledState} ${focusRing}`}
        >
          <Icon icon={Columns2} size="sm" />
        </button>
      )}

      {/* Revealed on hover and on focus like its neighbours, and always visible once the item is
            kept - a star that vanished when the pointer left would mean a reader could not tell
            what they had bookmarked without hovering every row in turn. `BookmarkButton` owns the
            pressed state and the toggle; the classes here are the row's, because only the row knows
            what its controls look like. */}
      <BookmarkButton
        compact
        itemId={item.id}
        title={item.title}
        className={`flex size-5 max-sm:size-(--control-sm) items-center justify-center text-muted opacity-0 pointer-events-none hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 max-sm:pointer-events-auto max-sm:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 pointer-coarse:size-(--control-lg) ${keptIds.has(item.id) ? 'opacity-100 pointer-events-auto' : 'sm:pointer-coarse:hidden'} ${focusRing}`}
      />

      {/* The labelled equivalent of dragging: pick a place and a position in a dialog. */}
      <button
        type="button"
        data-context-menu-ignore
        aria-label={`Move ${item.title || 'Untitled'} to…`}
        onClick={() => {
          onMoveItem(item.id);
        }}
        className={`flex size-5 max-sm:size-(--control-sm) items-center justify-center text-muted opacity-0 pointer-events-none hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 max-sm:pointer-events-auto max-sm:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 pointer-coarse:size-(--control-sm) in-data-[layout=touch]:size-(--control-md)! sm:pointer-coarse:hidden ${focusRing}`}
      >
        <Icon icon={FolderInput} size="sm" />
      </button>

      {/* A direct escape from nesting. Dragging beside a root or pressing Alt+Left once per
            ancestor still works, but neither is a reasonable requirement for the common outcome
            "put this in the workspace". Appended after the current last root so moving does not
            unexpectedly reorder the roots already there. */}
      {item.parentId === null ? null : (
        <button
          type="button"
          data-context-menu-ignore
          aria-label={`Move ${item.title || 'Untitled'} to the workspace root`}
          onClick={() => {
            moveToRoot();
          }}
          className={`flex size-5 max-sm:size-(--control-sm) items-center justify-center text-muted opacity-0 pointer-events-none hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 max-sm:pointer-events-auto max-sm:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 pointer-coarse:size-(--control-sm) in-data-[layout=touch]:size-(--control-md)! sm:pointer-coarse:hidden ${focusRing}`}
        >
          <Icon icon={FolderUp} size="sm" />
        </button>
      )}

      {/* No control at all on a protected row: a destructive button that can only refuse is
            worse than its absence, and the shield beside the title says why it is missing. */}
      {deleteProtected ? null : (
        <button
          type="button"
          data-context-menu-ignore
          aria-label={`Delete ${item.title}`}
          onClick={() => {
            // Immediate, on purpose - see `requestDelete` on `app-shell.tsx` for why a toast
            // with Undo replaced the `globalThis.confirm()` this control used to sit behind. The
            // control is revealed on hover and sits a few pixels from the one that opens the
            // item, which is exactly the situation Undo (rather than a slower "are you sure") is
            // meant to answer.
            onDeleteItem(item);
          }}
          // `opacity-0` for the same reason the control above it uses one: `visibility: hidden`
          // takes an element out of the tab order, so this was keyboard-unreachable - and of the
          // two controls in this row it is the destructive one. `pointer-events-none` and the
          // narrow-scoped sizing and always-visible state follow the same reasoning as that
          // control's own comment, as does the `pointer-coarse:` trio beside it: `group-hover:*`
          // needs `@media(hover:hover)`, so a touch-capable device above `sm` gets neither that nor
          // the `max-sm:` override without it.
          //
          // `pointer-coarse:ml-2` widens the gap in front of this control only: on touch, a thumb
          // landing between "move to root" and the bookmark star and this destructive action has
          // less margin for error than a mouse pointer does, and the row's own `gap-1` is otherwise
          // the same narrow spacing on every control in it.
          className={`flex size-5 max-sm:size-(--control-sm) items-center justify-center text-muted opacity-0 pointer-events-none hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 max-sm:pointer-events-auto max-sm:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 pointer-coarse:size-(--control-sm) in-data-[layout=touch]:size-(--control-md)! sm:pointer-coarse:hidden ${focusRing}`}
        >
          <Icon icon={Trash2} size="sm" />
        </button>
      )}

      {/* On a touch tablet the four 28px row buttons fold into this one 44px menu, the way the
            phone browser does; a kept item's star stays beside it as the bookmark indicator. */}
      <Menu label={`Actions for ${item.title || 'Untitled'}`} items={contextItems()}>
        {(trigger) => (
          <button
            {...trigger}
            type="button"
            data-context-menu-ignore
            aria-label={`Actions for ${item.title || 'Untitled'}`}
            className={`hidden sm:pointer-coarse:flex pointer-coarse:size-(--control-lg) items-center justify-center text-muted hover:text-foreground ${focusRing}`}
          >
            <Icon icon={MoreHorizontal} size="sm" />
          </button>
        )}
      </Menu>
    </div>
  );
}
