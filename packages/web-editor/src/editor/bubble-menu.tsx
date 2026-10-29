import { Icon, placeFloatingMenu, readViewportBounds } from '@nix/ui';
import type { TextColor } from '@nix/editor-schema';
import type { Editor } from '@tiptap/react';
import { useFloatingPlacement } from './floating-placement';
import { suggestionIdsAt } from './suggesting';
import type { MarkType, Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  Baseline,
  Bold,
  Code,
  Highlighter,
  Italic,
  MessageSquarePlus,
  Sparkles,
  Strikethrough,
  Underline,
  type LucideIcon,
} from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';

/**
 * The selection bubble menu: a small toolbar that appears over selected text.
 *
 * Common text styles and both colour axes stay beside the selection, including on touch
 * screens where keyboard shortcuts and the main toolbar may not be within reach.
 *
 * **The same shape as the slash menu, deliberately.** The document's selection is the source of
 * truth, read back out of the editor on every transaction - and on scroll and resize too,
 * because the box is placed in viewport coordinates against text that moves without a
 * transaction: the editor scrolls inside its own overflow container. Focus stays in the editor
 * for pointer users (mousedown on the menu is swallowed before it can blur the text); keyboard
 * users Tab to it, because the menu sits after the editable region in the DOM. It costs one tab
 * stop, not six: `role="toolbar"` promises arrow-key navigation, so the focus roves between the
 * buttons rather than the Tab key walking them - across both groups, because a toolbar is one
 * widget however many groups it holds, and a second tab stop would be a second widget.
 *
 * The vendor's bubble-menu plugin was configured but never given an element - it draws nothing
 * without one - and wiring it up would have bought floating-ui positioning at the price of a
 * second show/hide model to keep in step with this file's own.
 *
 * **The colours are token roles, not values.** Each button applies a name from the schema's
 * closed set; what the name looks like is decided by `prose.ts` against the design tokens at
 * render, which is what keeps a stored document legible on both grounds. `default` clears the
 * mark rather than writing a literal "ordinary text" colour into the document - the command in
 * `@nix/editor-schema` owns that rule.
 */

/** The ink, or the wash behind it - the schema's two attributes, under the names it uses. */
type ColorAxis = 'text' | 'background';

interface ColorOption {
  readonly color: TextColor;
  /** The visible word. Colour alone cannot tell accent from muted - both are greys on a mono sheet. */
  readonly name: string;
  /** The accessible name, which contains the visible word so voice control can reach it. */
  readonly label: string;
  /** What the choice renders as - the honest preview, applied to the word on the button. */
  readonly swatchClass: string;
}

interface ColorGroup {
  readonly axis: ColorAxis;
  /** The group's accessible name, and the word the two icons are shorthand for. */
  readonly label: string;
  readonly icon: LucideIcon;
  readonly options: readonly ColorOption[];
}

/**
 * The two groups, in the order they are walked.
 *
 * **Each button says which axis it sets, in its own accessible name.** A `role="group"` with a
 * label is announced on entry and drawn as a gap, which is the right structure and not enough
 * on its own: a screen-reader user arriving at one button by arrow key hears only that button,
 * and voice control matches the accessible name and nothing around it. "Accent colour" and
 * "Accent highlight" are reachable and unambiguous alone; "Accent" twice would not be. The
 * visible word stays short and the icon carries the axis for sighted users - a baseline for
 * ink, a marker pen for the wash.
 */
const COLOR_GROUPS: readonly ColorGroup[] = [
  {
    axis: 'text',
    label: 'Text colour',
    icon: Baseline,
    options: [
      {
        color: 'default',
        name: 'Default',
        label: 'Default colour',
        swatchClass: 'text-foreground',
      },
      // The same role the applied mark renders with (`prose.ts`), so the button shows exactly
      // what the text will become - accent-text rather than the base accent, because this is
      // body-size text and the base ramp step does not carry body-size contrast.
      { color: 'accent', name: 'Accent', label: 'Accent colour', swatchClass: 'text-accent-text' },
      { color: 'muted', name: 'Muted', label: 'Muted colour', swatchClass: 'text-muted' },
    ],
  },
  {
    axis: 'background',
    label: 'Highlight',
    icon: Highlighter,
    options: [
      { color: 'default', name: 'None', label: 'No highlight', swatchClass: 'text-foreground' },
      // The wash and its ink together, exactly as `prose.ts` renders them - a preview that
      // showed the wash without the ink it forces would be a preview of something else.
      {
        color: 'accent',
        name: 'Accent',
        label: 'Accent highlight',
        swatchClass: 'bg-accent-200 text-neutral-900',
      },
      {
        color: 'muted',
        name: 'Muted',
        label: 'Muted highlight',
        swatchClass: 'bg-neutral-300 text-neutral-900',
      },
    ],
  },
];

/** Every option in one row, which is the order the roving focus walks it in. */
const ROW: readonly { readonly group: ColorGroup; readonly option: ColorOption }[] =
  COLOR_GROUPS.flatMap((group) => group.options.map((option) => ({ group, option })));

/**
 * Each option's place in that row.
 *
 * Keyed by the option object rather than by its colour, because the same three colours appear
 * in both groups and a key that collided would give two buttons one tab stop between them.
 */
const ROW_INDEX: ReadonlyMap<ColorOption, number> = new Map(
  ROW.map((entry, index) => [entry.option, index]),
);

const TEXT_STYLES = [
  { mark: 'bold', label: 'Bold', icon: Bold },
  { mark: 'italic', label: 'Italic', icon: Italic },
  { mark: 'underline', label: 'Underline', icon: Underline },
  { mark: 'strike', label: 'Strikethrough', icon: Strikethrough },
  { mark: 'code', label: 'Inline code', icon: Code },
] satisfies readonly { readonly mark: string; readonly label: string; readonly icon: LucideIcon }[];

/** Whether the command behind `axis` can run where the selection is. */
function canSet(can: ReturnType<Editor['can']>, axis: ColorAxis, color: TextColor): boolean {
  return axis === 'text' ? can.setTextColor(color) : can.setTextBackground(color);
}

/** Applies `color` on `axis`, keeping the focus in the text the selection is in. */
function applyColor(editor: Editor, axis: ColorAxis, color: TextColor): void {
  const chain = editor.chain().focus(undefined, { scrollIntoView: false });
  if (axis === 'text') {
    chain.setTextColor(color).run();
  } else {
    chain.setTextBackground(color).run();
  }
}

/**
 * The viewport room the menu needs above a selection: its own row plus the gap. A selection
 * nearer the top edge than this gets the menu underneath instead, where there is room - the
 * alternative is a toolbar drawn off-screen for anybody colouring their first line.
 */
const MENU_CLEARANCE = 80;

/**
 * A rough upper bound on the menu's own width, wide enough to cover both colour groups on any
 * screen this renders on. Used only to keep its left edge from being clamped past where the menu
 * would actually reach - the row itself still sizes to its content, not to this number.
 */
const MENU_WIDTH_ESTIMATE = 720;

/**
 * Whether a range holds any text at all.
 *
 * `textBetween` would answer the same question by building the string first: on a select-all of
 * a long note that is the whole document materialised - measured at 131 KB per call, and 12.5 MB
 * of garbage across a hundred scroll events - to decide a yes or a no. This stops at the first
 * text node it finds. A bare node selection still reads as "no text", which is the distinction
 * the caller depends on.
 */
function hasText(doc: ProseMirrorNode, from: number, to: number): boolean {
  let found = false;

  doc.nodesBetween(from, to, (node, pos) => {
    if (found) {
      return false;
    }
    // The node has to overlap the range, not merely be visited: `nodesBetween` hands over the
    // ancestors of the endpoints too, and a text node touching the boundary contributes nothing.
    if (node.isText && Math.min(to, pos + node.nodeSize) > Math.max(from, pos)) {
      found = true;
      return false;
    }
    return true;
  });

  return found;
}

/**
 * Whether a stored axis says nothing.
 *
 * The same reading the schema's clearing rule uses (`marks.ts`): a missing value and a stored
 * `'default'` both mean "no colour here", and `'default'` is also what an unknown colour from a
 * newer build renders as. Read here rather than imported, because this is the question "is
 * there anything to show as pressed", which is the menu's own, not the document's.
 */
function axisAbsent(value: unknown): boolean {
  return value === null || value === undefined || value === '' || value === 'default';
}

/**
 * Which axes carry a colour anywhere in the range.
 *
 * The positive test behind the two "no colour" buttons. `rangeHasMark` cannot answer it: the
 * mark carries both axes, so a range holding only a highlight would say the foreground is
 * coloured, and "Default colour" would go unpressed over text that is plainly default.
 *
 * One walk for both axes rather than one each, stopping as soon as both are answered - this
 * runs on every transaction and every scroll frame the menu is open, over a range that may be
 * the whole document.
 */
function axesInRange(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  markType: MarkType | undefined,
): Readonly<Record<ColorAxis, boolean>> {
  const found = { text: false, background: false };

  if (markType === undefined) {
    return found;
  }

  doc.nodesBetween(from, to, (node, pos) => {
    if (found.text && found.background) {
      return false;
    }
    // Overlapping the range, not merely visited - the same distinction `hasText` draws above.
    if (!node.isText || Math.min(to, pos + node.nodeSize) <= Math.max(from, pos)) {
      return true;
    }
    for (const mark of node.marks) {
      if (mark.type !== markType) {
        continue;
      }
      const attributes: Record<string, unknown> = mark.attrs;
      found.text = found.text || !axisAbsent(attributes.text);
      found.background = found.background || !axisAbsent(attributes.background);
    }
    return true;
  });

  return found;
}

/** Where the menu sits, and which selection it belongs to. */
interface MenuPlacement {
  readonly left: number;
  readonly top: number;
  /** Flipped under the selection, because the viewport had no room above it. */
  readonly below: boolean;
  readonly maxWidth: number;
  readonly maxHeight: number;
  /** The selected range, so a dismissal is of this selection rather than of all of them. */
  readonly from: number;
  readonly to: number;
}

/**
 * A fresh object on every transaction, not only when the coordinates move: a colour applied to a
 * standing selection changes no coordinate, and the buttons' pressed state has to re-render from
 * the new document all the same.
 */
function readPlacement(editor: Editor): MenuPlacement | null {
  const { state } = editor;
  const { from, to, empty } = state.selection;

  // Only a selection that actually holds text. An empty selection is a caret; a non-empty
  // one over no text (a bare node selection, a table cell boundary) has nothing this menu's
  // commands could colour.
  if (empty ? suggestionIdsAt(state).length === 0 : !hasText(state.doc, from, to)) {
    return null;
  }

  const coords = editor.view.coordsAtPos(from);

  // Above the selection by default, flipping below only when the viewport has no room above
  // it - the same clamp the slash and reference menus use, with the preferred side reversed:
  // this menu opens over the selection, not under the caret. On a touch screen it always
  // opens below regardless of room, because iOS draws its own Copy/Paste bar directly above
  // a selection, and this menu would otherwise open right underneath it.
  const placed = placeFloatingMenu(
    { left: coords.left, top: coords.top, bottom: coords.bottom },
    MENU_WIDTH_ESTIMATE,
    readViewportBounds(),
    {
      preferAbove: true,
      forceBelow:
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(any-pointer: coarse)').matches,
      minHeight: MENU_CLEARANCE,
    },
  );

  return {
    left: placed.left,
    top: placed.top,
    below: !placed.above,
    maxWidth: placed.maxWidth,
    maxHeight: Math.max(0, placed.maxHeight - 8),
    from,
    to,
  };
}

export function BubbleMenu({
  editor,
  onOpenInlineAi,
  onComment,
}: {
  readonly editor: Editor;
  /** Opens the comments pane with the selection as the draft's place; absent where comments are off. */
  readonly onComment?: (() => void) | undefined;
  /** Present only when the writing assistance is on offer; the control exists only then. */
  readonly onOpenInlineAi?: (() => void) | undefined;
}): ReactNode {
  // The selection Escape dismissed the menu over. Selecting something else opens it again.
  const [dismissed, setDismissed] = useState<{ readonly from: number; readonly to: number } | null>(
    null,
  );

  // Which button holds the toolbar's one tab stop. An index rather than a colour, so the arrow
  // keys can walk the row without caring what is on it.
  const [focusIndex, setFocusIndex] = useState(0);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const container = useRef<HTMLDivElement | null>(null);
  const placement = useFloatingPlacement(editor, readPlacement, container);

  // After the hooks, which have to run unconditionally. `useEditor` tears an editor down and
  // builds another whenever its dependencies change - strict mode does it on every mount - and
  // a render landing in that gap must not reach `can()` on an editor whose command manager is
  // already null. `toolbar.tsx` documents the crash this guard exists for.
  if (editor.isDestroyed) {
    return null;
  }

  const open =
    placement !== null &&
    !(dismissed !== null && dismissed.from === placement.from && dismissed.to === placement.to);

  // Nothing below this line is worth computing for a menu that draws nothing - and a dismissed
  // menu is exactly that for as long as the selection it was dismissed over stands: `placement`
  // stays set, so every transaction and every scroll still re-renders this component. The live
  // region stays mounted, because a region that comes and goes is one a screen reader may not
  // be watching when the menu next opens.
  //
  // The fragment matches the open branch's shape so React reconciles the live region as the
  // same element across both, rather than tearing it down and inserting a fresh one: a region
  // that has only just appeared is one a screen reader may not yet be watching.
  if (!open) {
    return (
      <>
        <p aria-live="polite" className="sr-only" />
      </>
    );
  }

  // A note that cannot be edited can still be commented on: the bubble then holds that one button.
  if (!editor.isEditable) {
    if (onComment === undefined) return null;
    return (
      <div
        role="toolbar"
        aria-label="Selection actions"
        style={{ left: placement.left, top: placement.top, maxWidth: placement.maxWidth }} // design-token-exempt: position and size are measured against the visible viewport.
        className={[
          'fixed z-20 flex items-center rounded-md border border-divider bg-surface p-1 shadow-md',
          placement.below ? 'mt-2' : '-mt-2 -translate-y-full',
        ].join(' ')}
        onMouseDown={(event) => {
          event.preventDefault();
        }}
      >
        <button
          type="button"
          onClick={onComment}
          className="flex min-h-11 shrink-0 items-center gap-1 rounded-sm px-2 text-xs hover:bg-foreground/7 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          <Icon icon={MessageSquarePlus} size="sm" />
          <span className="px-0.5">Comment</span>
        </button>
      </div>
    );
  }

  // Whether each command can run where the selection is. Marks are not admitted inside a code
  // block or inline code, and a button that would silently do nothing is worse than one that
  // says it cannot.
  //
  // One `can()` for all six probes: each call builds a proxy over every registered command
  // and each invocation re-evaluates that map, so a call per probe was about 700 closures a
  // render for three of them (measured 66-136 microseconds). Sharing it is safe because `can()`
  // captures one transaction and every probe through it runs undispatched.
  const can = editor.can();
  const runnable = TEXT_STYLES.map((style) => can.toggleMark(style.mark));
  runnable.push(...ROW.map((entry) => canSet(can, entry.group.axis, entry.option.color)));
  // The writing assistance is one more stop at the end of the row, so the toolbar stays one
  // widget with one tab stop. Offered only where the note can be written to.
  const aiIndex = onOpenInlineAi !== undefined ? runnable.length : null;
  if (aiIndex !== null) runnable.push(true);
  const commentIndex = onComment !== undefined ? runnable.length : null;
  if (commentIndex !== null) runnable.push(true);
  // Accept and Reject, for the suggestion(s) under the selection: two more stops in the same row.
  const suggestionIds = suggestionIdsAt(editor.state);
  const decideIndex = suggestionIds.length > 0 ? runnable.length : null;
  if (decideIndex !== null) runnable.push(true, true);

  // The tab stop has to sit on a button that can actually be used.
  const firstRunnable = runnable.indexOf(true);
  const tabStop = runnable[focusIndex] === true ? focusIndex : firstRunnable;

  /** Moves the roving focus along by `step` buttons, passing over any that cannot run. */
  function rove(from: number, step: number): void {
    const count = runnable.length;
    for (let i = 1; i <= count; i += 1) {
      const next = (((from + step * i) % count) + count) % count;
      if (runnable[next] === true) {
        setFocusIndex(next);
        buttons.current[next]?.focus();
        return;
      }
    }
  }

  // Whether *any* of the selection carries a colour on each axis - a different question from
  // `isActive`'s "does all of it carry this colour". A selection spanning coloured and
  // uncoloured text is neither default nor accent, and saying "Default colour, pressed" over it
  // would be a lie. Mixed presses nothing.
  const coloured = axesInRange(
    editor.state.doc,
    placement.from,
    placement.to,
    editor.state.schema.marks.textColor,
  );
  const { left, top, maxWidth, maxHeight } = placement;

  return (
    <>
      {/* Announced when the menu appears. It opens away from the focus, so without this a
          screen-reader user who has just selected text has no way to know the options exist. */}
      <p aria-live="polite" className="sr-only">
        Selection formatting options available
      </p>

      <div
        ref={container}
        role="toolbar"
        aria-label="Selection formatting"
        aria-orientation="horizontal"
        // Positioned against the selection in viewport coordinates, re-read on scroll and on
        // resize above, so it stays with its text rather than with the page.
        style={{ left, top, maxWidth, maxHeight }} // design-token-exempt: position and size are measured against the visible viewport.
        className={[
          // The wider gap is what separates the two groups: they are the same kind of thing on
          // the same surface, so a rule between them would be a border used where air will do.
          'fixed z-20 flex items-center gap-2 overflow-x-auto overscroll-x-contain rounded-md border border-divider bg-surface p-1 shadow-md',
          placement.below ? 'mt-2' : '-mt-2 -translate-y-full',
        ].join(' ')}
        // Swallowed before the browser can move focus: a pointer press on a menu button must
        // not blur the editor, or the selection being coloured would collapse under the click.
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onKeyDown={(event) => {
          // Escape closes this layer and puts the caret back in the text it came from. It
          // stops there: the innermost open layer wins the key, which is the convention
          // `slash-menu.tsx` and `command-palette.tsx` document.
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setDismissed({ from: placement.from, to: placement.to });
            editor.commands.focus();
            return;
          }

          // The roving tab stop that `role="toolbar"` promises: the arrows walk the row - the
          // whole row, straight through the group boundary, because the groups are a way of
          // reading the toolbar and not a wall inside it - Home and End jump to its ends, and
          // Tab stays one stop through all of it.
          if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            event.preventDefault();
            rove(tabStop, 1);
          } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
            event.preventDefault();
            rove(tabStop, -1);
          } else if (event.key === 'Home') {
            event.preventDefault();
            rove(runnable.length - 1, 1);
          } else if (event.key === 'End') {
            event.preventDefault();
            rove(0, -1);
          }
        }}
      >
        <div role="group" aria-label="Text styles" className="flex shrink-0 items-center gap-0.5">
          {TEXT_STYLES.map((style, offset) => {
            const index = offset;
            const active = editor.isActive(style.mark);
            return (
              <button
                key={style.mark}
                ref={(element) => {
                  buttons.current[index] = element;
                }}
                type="button"
                aria-label={style.label}
                title={style.label}
                aria-pressed={active}
                disabled={runnable[index] !== true}
                tabIndex={index === tabStop ? 0 : -1}
                onClick={() => {
                  editor
                    .chain()
                    .focus(undefined, { scrollIntoView: false })
                    .toggleMark(style.mark)
                    .run();
                }}
                className={[
                  'flex size-11 shrink-0 items-center justify-center rounded-sm',
                  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
                  runnable[index] !== true
                    ? 'cursor-not-allowed opacity-40'
                    : active
                      ? 'bg-accent/18'
                      : 'hover:bg-foreground/7',
                ].join(' ')}
              >
                <Icon icon={style.icon} size="sm" />
              </button>
            );
          })}
        </div>
        {COLOR_GROUPS.map((group) => (
          <div
            key={group.axis}
            role="group"
            aria-label={group.label}
            className="flex shrink-0 items-center gap-0.5"
          >
            {group.options.map((option) => {
              const index = TEXT_STYLES.length + (ROW_INDEX.get(option) ?? 0);
              const active =
                option.color === 'default'
                  ? !coloured[group.axis]
                  : editor.isActive('textColor', { [group.axis]: option.color });
              const disabled = runnable[index] !== true;

              return (
                <button
                  key={option.color}
                  ref={(element) => {
                    buttons.current[index] = element;
                  }}
                  type="button"
                  aria-label={option.label}
                  title={option.label}
                  aria-pressed={active}
                  disabled={disabled}
                  tabIndex={index === tabStop ? 0 : -1}
                  onClick={() => {
                    applyColor(editor, group.axis, option.color);
                  }}
                  className={[
                    'flex min-h-11 items-center gap-1 rounded-sm px-2 text-xs',
                    'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
                    disabled
                      ? 'cursor-not-allowed opacity-40'
                      : active
                        ? 'bg-accent/18'
                        : 'hover:bg-foreground/7',
                  ].join(' ')}
                >
                  <Icon icon={group.icon} size="sm" />
                  {/* The preview sits on the word rather than on the button, so a wash can be
                      shown as a wash without fighting the button's own pressed and hover
                      grounds - and it is spelled the way `prose.ts` spells the real mark. */}
                  <span className={`rounded-sm px-0.5 ${option.swatchClass}`}>{option.name}</span>
                </button>
              );
            })}
          </div>
        ))}
        {aiIndex === null ? null : (
          <button
            ref={(element) => {
              buttons.current[aiIndex] = element;
            }}
            type="button"
            aria-label="Write with AI"
            title="Write with AI"
            aria-haspopup="dialog"
            tabIndex={aiIndex === tabStop ? 0 : -1}
            onClick={onOpenInlineAi}
            className="flex min-h-11 shrink-0 items-center gap-1 rounded-sm px-2 text-xs hover:bg-foreground/7 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
          >
            <Icon icon={Sparkles} size="sm" />
            <span className="px-0.5">AI</span>
          </button>
        )}
        {commentIndex === null ? null : (
          <button
            ref={(element) => {
              buttons.current[commentIndex] = element;
            }}
            type="button"
            aria-label="Comment"
            title="Comment"
            tabIndex={commentIndex === tabStop ? 0 : -1}
            onClick={onComment}
            className="flex min-h-11 shrink-0 items-center gap-1 rounded-sm px-2 text-xs hover:bg-foreground/7 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
          >
            <Icon icon={MessageSquarePlus} size="sm" />
            <span className="px-0.5">Comment</span>
          </button>
        )}
        {decideIndex === null ? null : (
          <div role="group" aria-label="Suggestion" className="flex shrink-0 items-center gap-0.5">
            {(['accept', 'reject'] as const).map((decision, offset) => (
              <button
                key={decision}
                ref={(element) => {
                  buttons.current[decideIndex + offset] = element;
                }}
                type="button"
                tabIndex={decideIndex + offset === tabStop ? 0 : -1}
                onClick={() => {
                  const chain = editor.chain().focus(undefined, { scrollIntoView: false });
                  for (const id of suggestionIds) {
                    if (decision === 'accept') chain.acceptSuggestion(id);
                    else chain.rejectSuggestion(id);
                  }
                  chain.run();
                }}
                className="flex min-h-11 shrink-0 items-center gap-1 rounded-sm px-2 text-xs hover:bg-foreground/7 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
              >
                <span className="px-0.5">{decision === 'accept' ? 'Accept' : 'Reject'}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
