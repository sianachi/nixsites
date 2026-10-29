import { forwardRef } from 'react';
import type { ChangeEvent, FocusEvent, KeyboardEvent as ReactKeyboardEvent, Ref } from 'react';

/**
 * The inline-edit overlay shared by the spreadsheet view and the sheet grid: an
 * absolutely positioned input drawn over the active cell. Both callers own their own
 * selection state, commit/cancel logic and focus effect - this component only owns the
 * markup and styling the two had copied verbatim.
 *
 * `multiline` makes it a text area that grows down from the cell, for a value that keeps its
 * line breaks: a one-line input would strip them on the first keystroke. Enter still commits, as
 * in every spreadsheet; Alt+Enter or Shift+Enter starts a new line.
 */
const CELL_EDITOR_CLASSNAME =
  'absolute z-10 min-w-0 bg-background px-2 py-1 text-lg outline-2 -outline-offset-2 outline-accent';

/** The most lines a multi-line editor shows before it scrolls. */
const MAX_LINES = 8;

interface CellEditorPosition {
  top: string;
  left: string;
  width: string;
  height: string;
}

type EditorElement = HTMLInputElement | HTMLTextAreaElement;

export interface CellEditorProps {
  ariaLabel: string;
  value: string;
  position: CellEditorPosition;
  onChange: (event: ChangeEvent<EditorElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<EditorElement>) => void;
  onBlur: (event: FocusEvent<EditorElement>) => void;
  maxLength?: number;
  multiline?: boolean;
}

export const CellEditor = forwardRef<EditorElement, CellEditorProps>(function CellEditor(
  { ariaLabel, value, position, onChange, onKeyDown, onBlur, maxLength, multiline = false },
  ref,
) {
  if (!multiline) {
    return (
      <input
        ref={ref as Ref<HTMLInputElement>}
        aria-label={ariaLabel}
        value={value}
        maxLength={maxLength}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        className={CELL_EDITOR_CLASSNAME}
        style={position}
      />
    );
  }

  return (
    <textarea
      ref={ref as Ref<HTMLTextAreaElement>}
      aria-label={ariaLabel}
      aria-multiline="true"
      value={value}
      maxLength={maxLength}
      rows={Math.min(MAX_LINES, value.split('\n').length)}
      onChange={onChange}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.altKey || event.shiftKey)) {
          event.preventDefault();
          const field = event.currentTarget;
          field.setRangeText('\n', field.selectionStart, field.selectionEnd, 'end');
          // setRangeText changes the value without an input event, so React would not hear of it.
          field.dispatchEvent(new Event('input', { bubbles: true }));
          return;
        }
        onKeyDown(event);
      }}
      onBlur={onBlur}
      className={`${CELL_EDITOR_CLASSNAME} resize-none`}
      style={{ ...position, height: undefined, minHeight: position.height }} // design-token-exempt: the editor overlays the active cell, whose place is runtime geometry
    />
  );
});
