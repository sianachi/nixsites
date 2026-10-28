import { cva } from 'class-variance-authority';
import { X } from 'lucide-react';
import { useRef, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';

import { cn } from '../lib/cn';
import { ContextMenu, type ContextMenuTargetProps } from './ContextMenu';
import { type MenuEntry } from './Menu';
import { Icon } from '../primitives/Icon';
import { chromeSurface, focusRing, inkWashStates } from '../primitives/interaction';

/**
 * <Tabs> - a strip of open, independent documents, one of them showing.
 *
 * **A real tablist, unlike `<Segmented>` and `<ViewSwitcher>`.** Both of those settled on
 * `aria-current` because they toggle a display mode of the *same* content, which owes nothing
 * beyond a click. A tab here is bound to genuinely distinct content that keeps running while
 * backgrounded - a different document, a different realtime connection - which is exactly the
 * case the tablist pattern exists for: roving tabindex, arrow-key movement between tabs, and a
 * screen reader announcing "tab, 2 of 5" that the arrow keys actually back up.
 *
 * **Activation is manual, not on focus.** Arrow-keying across five tabs must not open and close
 * five documents on the way past - each carries a live connection, so the naive "focus moves,
 * selection follows" reading of the ARIA pattern would make browsing the strip itself expensive.
 * Enter or Space activates whatever is focused; the arrow keys only move focus.
 *
 * **The close affordance is pointer-only; the keyboard closes with Delete or Backspace on the
 * tab itself.** A tablist may own nothing but tabs, and a tab may not contain another interactive
 * control - a nested control is unreachable for assistive technology, which flattens a tab to its
 * name, and even a button at `tabindex="-1"` remains natively focusable. So the visible close
 * affordance is a plain `aria-hidden` span: mouse users get the familiar target, and everyone else
 * gets the same action from the tab element they are already on, announced through
 * `aria-keyshortcuts` on each closable tab.
 *
 * `pinned` is the only thing this component knows about preview tabs - it renders one italic and
 * nothing more. Which tab is a preview, when one is replaced, and when it is promoted to pinned
 * are all decisions the caller makes; this component only draws the result.
 *
 * **Orientation changes which arrow keys move focus, not just which way the strip lays out.**
 * The WAI-ARIA tablist pattern binds Left/Right to a horizontal strip and Up/Down to a vertical
 * one - never both - so a vertical strip that still answered to Left/Right would be a tablist
 * lying about `aria-orientation`. Home and End reach either end regardless, the same as both of
 * `<Nav>`'s orientations already have List semantics rather than direction ones.
 */

export interface TabItem {
  readonly id: string;
  readonly label: string;
  /** Preview tabs render italic; omit or set true for a pinned, permanent tab. */
  readonly pinned?: boolean;
  /** Whether a close control is offered for this tab. Defaults to true. */
  readonly closable?: boolean;
}

export type TabsOrientation = 'horizontal' | 'vertical';

interface TabsDrag {
  readonly onStart: (id: string, event: DragEvent<HTMLElement>) => void;
  readonly onEnd: () => void;
}

export interface TabsProps {
  /** What the strip as a whole is for. Becomes the tablist's accessible name. */
  readonly label: string;

  readonly items: readonly TabItem[];

  readonly activeId: string;

  readonly onActivate: (id: string) => void;

  /** Omit to render every tab without a close control. */
  readonly onClose?: (id: string) => void;

  /** A row above its content, or a rail beside it. Defaults to horizontal. */
  readonly orientation?: TabsOrientation;

  /** Its presence enables native dragging; callers omit it for coarse-pointer surfaces. */
  readonly drag?: TabsDrag;

  /**
   * The actions a secondary click on a tab offers, built when the menu opens. Omit, or return no
   * entries, to leave the browser's own menu in place.
   */
  readonly contextMenu?: (id: string) => readonly MenuEntry[];

  /** Layout only. */
  readonly className?: string;
}

const tablistVariants = cva(cn('flex min-w-0 items-stretch', chromeSurface), {
  variants: {
    orientation: {
      // `min-w-0` on the base above is what lets `overflow-x-auto` here ever engage: a caller
      // that sizes the strip with `flex-1` (`document-tab-strip.tsx`) makes it a flex item too,
      // and a flex item's default `min-width: auto` refuses to shrink below its content's width -
      // which is exactly the content this scrolls, so the scrollbar never had a reason to appear.
      horizontal: 'flex-row overflow-x-auto border-b border-divider',
      // A fixed width, unlike the horizontal strip's shrink-to-content: a rail's whole point is
      // that a title truncates rather than sets how wide the pane's content gets to be.
      vertical: 'w-40 shrink-0 flex-col overflow-y-auto border-r border-divider',
    },
  },
  defaultVariants: { orientation: 'horizontal' },
});

const tabVariants = cva(
  cn(
    'group flex min-w-0 shrink-0 items-center gap-1 text-sm any-pointer-coarse:min-h-(--control-lg) any-pointer-coarse:text-md transition-colors',
    focusRing,
  ),
  {
    variants: {
      orientation: {
        // A cap, unlike the vertical rail's own `w-40`: a horizontal strip has no fixed width to
        // divide, so without one a single long title claims however much space it wants and pushes
        // every tab after it - and the strip's own scroll and close controls - off the visible
        // strip. Narrower still under `sm`, where the whole strip is narrower than one uncapped tab.
        horizontal:
          '-mb-px max-w-48 border-b-2 px-3 py-1.5 any-pointer-coarse:py-0 max-sm:max-w-32',
        vertical: '-mr-px border-r-2 px-3 py-1.5 any-pointer-coarse:py-0',
      },
      active: {
        true: 'border-accent-text text-foreground',
        false: cn('border-transparent text-muted hover:text-foreground', inkWashStates),
      },
    },
    defaultVariants: { orientation: 'horizontal', active: false },
  },
);

export function Tabs(props: TabsProps): ReactNode {
  const {
    label,
    items,
    activeId,
    onActivate,
    onClose,
    orientation = 'horizontal',
    drag,
    contextMenu,
    className,
  } = props;
  const listRef = useRef<HTMLDivElement>(null);

  function focusTabAt(index: number): void {
    const list = listRef.current;
    if (list === null) {
      return;
    }

    const tabs = list.querySelectorAll<HTMLElement>('[role="tab"]');
    tabs[index]?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>, index: number, item: TabItem): void {
    const forward = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
    const backward = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';

    switch (event.key) {
      case forward:
        event.preventDefault();
        focusTabAt((index + 1) % items.length);
        break;
      case backward:
        event.preventDefault();
        focusTabAt((index - 1 + items.length) % items.length);
        break;
      case 'Home':
        event.preventDefault();
        focusTabAt(0);
        break;
      case 'End':
        event.preventDefault();
        focusTabAt(items.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        onActivate(item.id);
        break;
      case 'Delete':
      case 'Backspace':
        if ((item.closable ?? true) && onClose !== undefined) {
          event.preventDefault();
          onClose(item.id);
        }
        break;
      default:
        break;
    }
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      aria-orientation={orientation === 'vertical' ? 'vertical' : undefined}
      className={cn(tablistVariants({ orientation }), className)}
    >
      {items.map((item, index) => {
        const active = item.id === activeId;
        const closable = (item.closable ?? true) && onClose !== undefined;

        // The tab itself, carrying the context-menu marker only when the caller offers tab actions.
        const drawTab = (contextTarget?: ContextMenuTargetProps): ReactNode => (
          <div
            key={item.id}
            {...contextTarget}
            role="tab"
            draggable={drag === undefined ? undefined : true}
            tabIndex={active ? 0 : -1}
            aria-selected={active}
            // Two shortcuts, space-separated, because the handler accepts both and the physical
            // keyboard makes that necessary rather than generous: the key labelled Delete on a Mac
            // laptop sends Backspace, so announcing only one of the pair names a key a large share
            // of people do not have.
            aria-keyshortcuts={closable ? 'Delete Backspace' : undefined}
            // The only place the key is written down for someone who can see the strip. The tab
            // already names itself through its own text, so this tooltip is additive rather than
            // the accessible name - it exists so the Delete shortcut is discoverable without a
            // screen reader reading `aria-keyshortcuts` aloud.
            title={
              drag !== undefined
                ? `${item.label} (Drag to another pane${closable ? '; Delete to close' : ''})`
                : closable
                  ? `${item.label} (Delete to close)`
                  : undefined
            }
            onDragStart={(event) => {
              drag?.onStart(item.id, event);
            }}
            onDragEnd={drag?.onEnd}
            onClick={() => {
              onActivate(item.id);
            }}
            onKeyDown={(event) => {
              handleKeyDown(event, index, item);
            }}
            className={cn(
              tabVariants({ orientation, active }),
              drag !== undefined && 'cursor-grab',
            )}
          >
            <span className={cn('truncate', item.pinned !== true && 'italic')}>{item.label}</span>

            {/* `closable` already folds in "the caller accepts a close" - TS narrows `onClose` through the alias. */}
            {closable ? (
              /*
              A pointer-only affordance, deliberately a span and deliberately outside the
              accessibility tree: a tablist may own nothing but tabs and a tab may not contain
              another interactive control, and even a `<button>` at `tabindex="-1"` stays a
              natively focusable element assistive technology can land on. Keyboard and
              screen-reader users close with Delete or Backspace on the tab itself, which
              `aria-keyshortcuts` above announces, and which the tab's own `title` writes down for
              a sighted keyboard user who has no screen reader to read that attribute out.
              Hidden until the tab is hovered, focused or active, the same reveal-on-proximity
              rule the pane divider and sidebar rows use. `any-pointer-coarse:` mirrors that: a touch
              pointer never fires `:hover`, so without it the close mark would stay invisible and
              under the 24px target floor on every tab but the active one - it forces the mark
              visible and grows its box to the 44px `--control-lg` touch step.

              The cost of `aria-hidden` here, so it is not rediscovered as a bug: this X is gone
              from the accessibility tree for *every* consumer of that tree, which includes
              voice-control users - "click Close Roadmap" no longer matches anything, and they
              must reach the tab and press Delete like other keyboard-driven users. That is the
              price of the tablist pattern's rule against interactive content inside a tab, and
              it is paid deliberately.

              No lint suppression is needed for a click handler with no key handler beside it:
              `jsx-a11y` stops asking for one once an element is `aria-hidden`, which is the same
              reasoning as the paragraphs above, reached independently.
            */
              <span
                aria-hidden="true"
                title={`Close ${item.label} (Delete)`}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(item.id);
                }}
                className={cn(
                  'shrink-0 cursor-default rounded-sm p-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
                  'any-pointer-coarse:flex any-pointer-coarse:size-(--control-lg) any-pointer-coarse:items-center any-pointer-coarse:justify-center any-pointer-coarse:p-0 any-pointer-coarse:opacity-100',
                  active && 'opacity-100',
                  inkWashStates,
                )}
              >
                <Icon icon={X} size="sm" />
              </span>
            ) : null}
          </div>
        );

        return contextMenu === undefined ? (
          drawTab()
        ) : (
          <ContextMenu
            key={item.id}
            label={`${item.label} tab actions`}
            items={() => contextMenu(item.id)}
          >
            {drawTab}
          </ContextMenu>
        );
      })}
    </div>
  );
}
