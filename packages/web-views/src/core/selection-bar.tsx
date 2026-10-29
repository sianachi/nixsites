import { Button, Text, blueprintFrame, cn } from '@nix/ui';
import { useCoarsePointer } from '@nix/web-foundation/layout/viewport';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface SelectionBarProps {
  readonly count: number;
  /** How many items the surface shows, for "Select all N". Absent or zero: no such button. */
  readonly shownCount?: number | undefined;
  readonly onSelectAll?: (() => void) | undefined;
  readonly onMove?: (() => void) | undefined;
  readonly onDelete?: (() => void) | undefined;
  readonly onClear: () => void;
  /** Extra per-view actions, drawn after Move and before the divider. */
  readonly children?: ReactNode;
  /**
   * The same bar drawn in place, in the flow, for a surface that is its own scroller (the
   * sidebar). Same order, same copy; no float and no motion.
   */
  readonly compact?: boolean;
}

/** How long the fall takes before the tray leaves the page. */
const FALL_MS = 150;

/**
 * The tray a pane shows while items are selected: the live count, "Select all N", Move, Delete, the
 * per-view actions, a divider, then Clear with its Esc hint.
 *
 * Floating (the default) it rides the bottom of the pane that owns the selection: a zero-height
 * sticky wrapper, so it never pushes content, plus a spacer that keeps the last row clear of it.
 * Opening never moves focus. It is a toolbar, so the arrow keys walk its buttons.
 */
export function SelectionBar(props: SelectionBarProps): ReactNode {
  const { count, compact = false } = props;
  // Held through the fall so the count does not read "0 selected" while the tray leaves.
  const [lastCount, setLastCount] = useState(count);
  if (count > 0 && count !== lastCount) setLastCount(count);
  const [present, setPresent] = useState(count > 0);
  if (count > 0 && !present) setPresent(true);
  useEffect(() => {
    if (count > 0 || !present) return;
    const timer = setTimeout(() => {
      setPresent(false);
    }, FALL_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [count, present]);

  if (compact) return count === 0 ? null : <Tray {...props} count={count} />;
  if (!present) return null;
  const open = count > 0;
  return (
    <>
      {open ? <div aria-hidden="true" className="h-16" /> : null}
      <div className="pointer-events-none sticky bottom-0 z-20 h-0">
        <div
          aria-hidden={open ? undefined : true}
          className={cn(
            'pointer-events-auto absolute inset-x-0 bottom-3 flex justify-center max-sm:px-2',
            'transition-[opacity,translate] duration-150 ease-out motion-reduce:transition-none',
            'starting:translate-y-2 starting:opacity-0',
            open ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0',
          )}
        >
          <Tray {...props} count={open ? count : lastCount} />
        </div>
      </div>
    </>
  );
}

function Tray(props: SelectionBarProps): ReactNode {
  const {
    count,
    shownCount = 0,
    onSelectAll,
    onMove,
    onDelete,
    onClear,
    children,
    compact = false,
  } = props;
  const bar = useRef<HTMLDivElement>(null);
  const coarse = useCoarsePointer();

  // The toolbar's arrow keys: left and right walk its buttons, Home and End jump to the ends.
  // Tab keeps its ordinary order, because the per-view actions are arbitrary buttons.
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(event.key) || bar.current === null) return;
    const buttons = [...bar.current.querySelectorAll<HTMLElement>('button:not(:disabled)')];
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    if (buttons.length === 0 || at === -1) return;
    event.preventDefault();
    const step =
      event.key === 'ArrowRight'
        ? at + 1
        : event.key === 'ArrowLeft'
          ? at - 1
          : event.key === 'Home'
            ? 0
            : buttons.length - 1;
    buttons[(step + buttons.length) % buttons.length]?.focus();
  }

  return (
    <div
      ref={bar}
      role="toolbar"
      aria-label="Selected items"
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className={cn(
        blueprintFrame,
        'flex flex-wrap items-center gap-2 bg-surface p-2',
        compact ? 'w-full' : 'w-max max-w-full shadow-md max-sm:w-full',
      )}
    >
      <Text variant="body" as="span" aria-live="polite" className="px-1">
        {`${String(count)} selected`}
      </Text>
      {onSelectAll !== undefined && count < shownCount ? (
        <Button variant="ghost" onClick={onSelectAll}>
          {`Select all ${String(shownCount)}`}
        </Button>
      ) : null}
      {onMove ? (
        <Button variant="secondary" onClick={onMove}>
          Move to…
        </Button>
      ) : null}
      {onDelete ? (
        <Button variant="secondary" onClick={onDelete}>
          Delete
        </Button>
      ) : null}
      {children}
      <span aria-hidden="true" className="w-px self-stretch bg-divider" />
      <Button variant="ghost" onClick={onClear}>
        Clear
        {coarse ? null : (
          <kbd
            aria-hidden="true"
            className="ml-2 rounded-sm bg-background px-1.5 font-body text-xs text-muted"
          >
            Esc
          </kbd>
        )}
      </Button>
    </div>
  );
}
