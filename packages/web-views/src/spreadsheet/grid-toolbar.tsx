import { useCompactCollection } from '@nix/web-foundation/layout/zen-presentation';
import { Button, Icon, Popover, Text, cn, focusRing } from '@nix/ui';
import { ArrowDownToLine, BoxSelect, Check, X } from 'lucide-react';
import { type ReactNode } from 'react';

interface GridToolbarProps {
  readonly hintId: string;

  /** Whether a cell editor is open: the apply and cancel buttons exist only then. */
  readonly editing: boolean;
  readonly onApply: () => void;
  readonly onCancel: () => void;

  readonly activeColumnLabel: string | undefined;

  /** The active row's title; undefined when no row is active. */
  readonly activeItemTitle: string | undefined;
  readonly canEdit: boolean;

  /** Whether the Edit button opens the typed-control popover rather than the in-cell editor. */
  readonly usesPopover: boolean;
  readonly popoverOpen: boolean;
  readonly popoverLabel: string;
  readonly onPopoverOpenChange: (open: boolean) => void;
  readonly popoverContent: (controls: { close: () => void }) => ReactNode;

  /** Tap-select mode: the first tap anchors a range, later taps extend it. */
  readonly selecting: boolean;
  readonly onToggleSelecting: () => void;
  readonly canFillDown: boolean;
  readonly onFillDown: () => void;
  /** "3 × 2 selected" while more than one cell is selected. */
  readonly selectionLabel: string | null;

  readonly onEdit: () => void;
}

export function GridToolbar(props: GridToolbarProps): ReactNode {
  const compact = useCompactCollection();
  const { activeColumnLabel, activeItemTitle } = props;
  const editLabel = `Edit ${activeColumnLabel ?? 'property'} for ${(activeItemTitle ?? '') || 'Untitled'}`;

  return (
    <>
      <p id={props.hintId} className="sr-only">
        Arrow keys move the active cell, and Shift extends the selection. Typing replaces text and
        number cells; Enter opens the property's editor, or opens the item on a title. Clicking a
        choice, checkbox, date or number cell opens its typed control. Control or Command with C
        copies and V pastes the selection as tab-separated text, D fills down from the selection’s
        first row, and Shift with D continues a series such as Week 1, Week 2 down the selection.
        Delete clears the selection. Tab and Shift+Tab move between cells rather than leaving the
        grid; press Escape, then Tab, to move focus out of it.
      </p>

      {/* The same model, findable by sight: a tap or a click alone reaches selection, editing
          and opening - a second tap on the already-active cell edits it, and this button opens
          it - so the keyboard ladder below is a shortcut, not the only door. */}
      <div className="mb-1 flex min-w-0 flex-wrap items-start justify-between gap-2">
        {!compact && (
          <details className="min-w-0 flex-1 pointer-coarse:hidden">
            <summary
              className={cn(
                'inline-flex min-h-(--control-md) cursor-default items-center any-pointer-coarse:min-h-(--control-lg)',
                focusRing,
              )}
            >
              <Text as="span" variant="note" tone="muted">
                Keyboard
              </Text>
            </summary>
            <Text as="p" variant="note" tone="muted">
              Arrows move, Shift extends. Type to replace text and numbers. Enter edits a property
              or opens the item on a title. Click a choice, checkbox, date or number cell to use its
              typed control. Ctrl/Cmd+C copies and Ctrl/Cmd+V pastes tab-separated text, Ctrl/Cmd+D
              fills down, Ctrl/Cmd+Shift+D continues a series, Delete clears. Escape, then Tab,
              leaves the grid.
            </Text>
          </details>
        )}

        {props.editing ? (
          <div className="flex shrink-0 gap-1">
            <Button
              variant="icon"
              aria-label="Apply property edit"
              onPointerDown={(event) => {
                event.preventDefault();
              }}
              onClick={props.onApply}
            >
              <Icon icon={Check} size="sm" />
            </Button>
            <Button
              variant="icon"
              aria-label="Cancel property edit"
              onPointerDown={(event) => {
                event.preventDefault();
              }}
              onClick={props.onCancel}
            >
              <Icon icon={X} size="sm" />
            </Button>
          </div>
        ) : null}

        <Button
          variant="secondary"
          className="min-w-0 max-w-full"
          aria-pressed={props.selecting}
          aria-label="Select a range of rows by tapping its first and last cell"
          onClick={props.onToggleSelecting}
        >
          <Icon icon={BoxSelect} size="sm" />
          <span className="truncate">Select range</span>
        </Button>

        {(!compact || props.selecting || props.canFillDown) && (
          <Button
            variant="secondary"
            className="min-w-0 max-w-full"
            disabled={!props.canFillDown}
            aria-label="Fill down: copy the first selected row into the rows below"
            onClick={props.onFillDown}
          >
            <Icon icon={ArrowDownToLine} size="sm" />
            <span className="truncate">Fill down</span>
          </Button>
        )}

        {props.selectionLabel === null ? null : (
          <Text as="span" variant="note" tone="muted" className="self-center">
            {props.selectionLabel}
          </Text>
        )}

        {props.usesPopover ? (
          <Popover
            label={props.popoverLabel}
            open={props.popoverOpen}
            onOpenChange={props.onPopoverOpenChange}
            trigger={(trigger) => (
              <Button
                {...trigger}
                variant="secondary"
                className="min-w-0 max-w-full"
                disabled={!props.canEdit}
                aria-label={editLabel}
              >
                <span className="truncate">Edit {activeColumnLabel ?? 'property'}</span>
              </Button>
            )}
          >
            {props.popoverContent}
          </Popover>
        ) : (
          <Button
            variant="secondary"
            className="min-w-0 max-w-full"
            disabled={!props.canEdit}
            aria-label={editLabel}
            onClick={props.onEdit}
          >
            <span className="truncate">Edit {activeColumnLabel ?? 'property'}</span>
          </Button>
        )}
      </div>
    </>
  );
}
