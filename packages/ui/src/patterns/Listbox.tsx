import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { type LucideIcon } from 'lucide-react';

import { cn } from '../lib/cn';
import { Icon } from '../primitives/Icon';
import { focusRingInset, listboxActiveOption } from '../primitives/interaction';
import { Text } from '../primitives/Text';

/**
 * <Listbox> - a filtered list of choices, driven from a text field that keeps the focus.
 *
 * The shape behind three different surfaces: the block inserter opened with `/`, the item picker
 * opened with `[[`, and the command palette. All three are the same object - type into a field,
 * move a highlight with the arrow keys, commit with Enter - and all three had been about to grow
 * their own copy of it.
 *
 * **Focus is never pulled into the list, and that is the whole reason this exists.** The obvious
 * implementation makes each option a `<button>` and lets Tab reach it, which puts a listbox's
 * options in the tab order, breaks type-ahead the moment focus leaves the field, and announces
 * every option as a button. The correct pattern keeps focus on the input and moves
 * `aria-activedescendant` instead, so a screen reader reads the highlighted option while the
 * person is still typing into the field they started in. That is fiddly enough - stable ids per
 * option, a controlled index, an `aria-controls` that has to resolve - that it is worth owning
 * once. The list element itself is still a tab stop of its own - a scrollable region must be
 * reachable by keyboard, and its options deliberately are not - and it answers to the same key
 * model, so landing on it directly loses nothing.
 *
 * **Escape is deliberately not handled here.** Which layer closes is the caller's to decide, and
 * the convention in `apps/web` is that the innermost open thing wins and calls `stopPropagation`.
 * A listbox that swallowed Escape would close the picker inside a dialog and leave the dialog open,
 * or worse, close both.
 */

/**
 * As much of a keyboard event as the key model reads.
 *
 * Structural rather than React's `KeyboardEvent`, because not every caller has one. The reference
 * picker keeps focus in the editor - the query it filters on lives in the document, so a field of
 * its own would swallow the typing - and hands this a DOM event off `editor.view.dom`. Both shapes
 * satisfy it, and neither has to be converted.
 */
interface ListboxKeyEvent {
  readonly key: string;
  preventDefault: () => void;
}

/** One choice. */
export interface ListboxOption {
  /** Stable across renders and unique within the list; what the caller gets back on selection. */
  readonly id: string;

  readonly label: string;

  /** A few words of context, shown after the label and never in place of it. */
  readonly hint?: string;

  readonly icon?: LucideIcon;

  /**
   * A heading this option sits under.
   *
   * A heading is drawn whenever the group changes from the previous option, so the caller orders
   * the list and the grouping follows - rather than passing nested arrays, which would make "the
   * fourth option overall" something every keyboard handler has to compute.
   */
  readonly group?: string;
}

/** The state and the wiring one listbox needs. Returned by {@link useListbox}. */
export interface ListboxController {
  /** The listbox element's id, for the input's `aria-controls`. */
  readonly id: string;

  /** Which option the highlight is on. Always in range, including after the list shrinks. */
  readonly activeIndex: number;

  /** The highlighted option's element id, for the input's `aria-activedescendant`. */
  readonly activeOptionId: string | undefined;

  /**
   * Whether there is a popup to speak of, for the input's `aria-expanded`.
   *
   * Every caller was hard-coding this to true, which told assistive technology a list was open
   * while the person was looking at "nothing matches".
   */
  readonly expanded: boolean;

  /** Moves the highlight. For pointer movement over the list. */
  readonly setActiveIndex: (index: number) => void;

  /** Commits an option, as Enter and a click both do. */
  readonly select: (index: number) => void;

  /**
   * The arrow keys and Enter, for whatever holds the focus.
   *
   * **Not Home and End**, though they were here at first. They move the caret in the text somebody
   * is typing, and taking them is worse than useless in the reference picker, where this handler is
   * attached to the editor itself: from `[[` until the picker closes, Home and End would stop
   * working in the document. The APG combobox pattern leaves them to the textbox for exactly this
   * reason.
   *
   * Not Escape and not Tab either: see the note on the module. Every other key falls through
   * untouched, so the thing it is attached to still behaves like itself.
   */
  readonly onKeyDown: (event: ListboxKeyEvent) => void;
}

/**
 * Owns a listbox's highlight and the keys that move it.
 *
 * @param options The current, already-filtered list.
 * @param onSelect Called with the committed option.
 * @returns The controller to give the input and the {@link Listbox}.
 */
export function useListbox(
  options: readonly ListboxOption[],
  onSelect: (option: ListboxOption, index: number) => void,
): ListboxController {
  const id = useId();
  const [storedIndex, setStoredIndex] = useState(0);

  // Clamped on the way out rather than corrected in an effect. The list changes on every
  // keystroke, so an effect that reset the index would leave one render where the highlight points
  // past the end - and that render is the one the person sees while they are typing.
  const activeIndex = storedIndex < options.length ? storedIndex : 0;

  function select(index: number): void {
    const option = options[index];
    if (option !== undefined) {
      onSelect(option, index);
    }
  }

  function onKeyDown(event: ListboxKeyEvent): void {
    if (options.length === 0) {
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        // Wrapping, because a list you filter is short and a person holding the key down expects
        // to come back round rather than stick at the bottom.
        setStoredIndex(activeIndex === options.length - 1 ? 0 : activeIndex + 1);
        break;

      case 'ArrowUp':
        event.preventDefault();
        setStoredIndex(activeIndex === 0 ? options.length - 1 : activeIndex - 1);
        break;

      case 'Enter':
        event.preventDefault();
        select(activeIndex);
        break;

      default:
        break;
    }
  }

  // The handlers are given a stable identity, with the current bodies reached through a ref at
  // call time. `useCallback` here is load-bearing rather than decorative, on the first of the three
  // grounds AGENTS.md allows: the identity is a dependency of a subscription. The reference picker
  // binds a `keydown` listener on the editor's own element in an effect keyed on this controller,
  // and without a stable identity that listener is torn down and re-added on every keystroke.
  const latest = useRef({ select, onKeyDown });

  useEffect(() => {
    latest.current = { select, onKeyDown };
  });

  const stableSelect = useCallback((index: number): void => {
    latest.current.select(index);
  }, []);

  const stableKeyDown = useCallback((event: ListboxKeyEvent): void => {
    latest.current.onKeyDown(event);
  }, []);

  return {
    id,
    activeIndex,
    activeOptionId: options.length === 0 ? undefined : optionElementId(id, activeIndex),
    expanded: options.length > 0,
    setActiveIndex: setStoredIndex,
    select: stableSelect,
    onKeyDown: stableKeyDown,
  };
}

export interface ListboxProps {
  /** What the list as a whole holds. Becomes its accessible name. */
  readonly label: string;

  readonly options: readonly ListboxOption[];

  readonly controller: ListboxController;

  /** What to say when nothing matches. A sentence, not a shrug. */
  readonly emptyMessage: string;

  /** Layout only. */
  readonly className?: string;
}

export function Listbox(props: ListboxProps): ReactNode {
  const { label, options, controller, emptyMessage, className } = props;
  const listRef = useRef<HTMLDivElement>(null);
  const { activeIndex, id: listboxId } = controller;

  // Scrolled here because nothing else will. Focus never moves into the list, so the browser has
  // no reason to bring the highlight into view - and both callers show more options than fit.
  // Without this, arrowing past the fold moves an invisible highlight and Enter commits something
  // the person cannot see, which is a wrong-item hazard rather than a cosmetic one.
  useEffect(() => {
    const active = listRef.current?.querySelector(
      `#${CSS.escape(optionElementId(listboxId, activeIndex))}`,
    );
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, listboxId]);

  // Runs of options sharing a heading. Built here rather than rendered inline so each run can be a
  // real `role="group"`: a listbox may own only options and groups, and a bare wrapper holding a
  // paragraph is neither. It also makes the heading part of every option's announcement, which is
  // what tells "run this command" from "open this document" in the palette's merged list.
  const runs: { group: string | undefined; from: number; options: ListboxOption[] }[] = [];
  for (const [index, option] of options.entries()) {
    const last = runs.at(-1);
    if (last !== undefined && last.group === option.group) {
      last.options.push(option);
    } else {
      runs.push({ group: option.group, from: index, options: [option] });
    }
  }

  return (
    <div className={cn('flex flex-col', className)}>
      {/*
        Rendered even when empty, so the input's `aria-controls` always resolves to something. An
        id that points at nothing is worse than an empty list: assistive technology reports the
        relationship as broken rather than as "no results".

        It carries no `hidden`, which it used to: `hidden` is `display: none`, which takes the
        element out of the accessibility tree and so undoes the very thing this comment is about.
        With no options the element has no children and no height, so there was nothing for it to
        hide either.

        `tabIndex` when, and only when, there is something to scroll. Being honest about what it
        buys, because the obvious reading of it is wrong: the keyboard route through this list is
        the arrow keys *from the field*, which move the highlight and let the effect above scroll
        it into view. It is not Tab into the list. Every caller dismisses the popup when the field
        blurs, so tabbing out of the field closes the list before focus could land here - this stop
        is, in practice, unreachable in the product.

        It stays for two reasons. It is what keeps `scrollable-region-focusable` satisfied: the
        wrapper the caller makes scrollable (via `className`) needs focusable content inside it,
        and the options are deliberately not focusable because the highlight travels by
        `aria-activedescendant`. And a caller that does not dismiss on blur gets a working focused
        listbox for free - the same keys, `aria-activedescendant` already in place.

        Conditional because an empty list is neither scrollable nor operable: without the guard, a
        picker showing "no results" would put a nameable, focusable, do-nothing stop in the tab
        order, which is a worse outcome than the rule it was placating.
      */}
      <div
        id={listboxId}
        ref={listRef}
        role="listbox"
        aria-label={label}
        tabIndex={options.length === 0 ? undefined : 0}
        aria-activedescendant={controller.activeOptionId}
        onKeyDown={controller.onKeyDown}
        className={focusRingInset}
      >
        {runs.map((run) => {
          const headingId =
            run.group === undefined ? undefined : `${listboxId}-group-${String(run.from)}`;

          const rendered = run.options.map((option, offset) => {
            const index = run.from + offset;
            const active = index === activeIndex;

            return (
              /*
                An option, not a button. Focus stays in the field the person is typing into and the
                highlight travels by `aria-activedescendant`; making these focusable would put them
                in the tab order and announce each one as a button.

                `onMouseDown` with `preventDefault` rather than `onClick`: a click first moves focus
                away from the input, and in the editor's picker that closes the whole thing before
                the selection is read. Committing on press keeps the field focused throughout.

                The disable below says the same thing to the linter: the rule is checking for the
                other mistake - an interactive role on something a keyboard cannot reach at all -
                and cannot see that the caller's field carries the keyboard model on its behalf.
              */
              // eslint-disable-next-line jsx-a11y/interactive-supports-focus
              <div
                key={option.id}
                id={optionElementId(listboxId, index)}
                role="option"
                aria-selected={active}
                onMouseDown={(event) => {
                  event.preventDefault();
                  controller.select(index);
                }}
                onMouseMove={() => {
                  if (!active) {
                    controller.setActiveIndex(index);
                  }
                }}
                className={cn(
                  'flex cursor-default items-center gap-2 px-3 py-2 text-sm select-none',
                  active ? listboxActiveOption : 'hover:bg-foreground/7',
                )}
              >
                {option.icon === undefined ? null : (
                  <Icon icon={option.icon} size="sm" className="shrink-0 text-muted" />
                )}

                <span className="min-w-0 flex-1 truncate">{option.label}</span>

                {option.hint === undefined ? null : (
                  <Text as="span" variant="caption" tone="muted" className="shrink-0">
                    {option.hint}
                  </Text>
                )}
              </div>
            );
          });

          if (run.group === undefined || headingId === undefined) {
            return rendered;
          }

          return (
            <div key={headingId} role="group" aria-labelledby={headingId}>
              <Text
                as="p"
                id={headingId}
                variant="caption"
                tone="muted"
                className="px-3 pt-3 pb-1 tracking-wide uppercase"
              >
                {run.group}
              </Text>
              {rendered}
            </div>
          );
        })}
      </div>

      {/*
        Mounted whether or not it has anything to say. A live region inserted into the document at
        the same moment as its text is unreliably announced - the region has to be there first for
        the change to be a change - which is the opposite of what this is for.
      */}
      <div role="status">
        {options.length === 0 ? (
          <Text as="p" variant="body" tone="muted" className="px-3 py-2">
            {emptyMessage}
          </Text>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The DOM id of one option.
 *
 * Derived from the listbox's own id and the option's position rather than from the option's
 * identifier, because an identifier may be a title, a path or anything else a person typed, and
 * `aria-activedescendant` needs something that is always a valid id.
 */
function optionElementId(listboxId: string, index: number): string {
  return `${listboxId}-option-${String(index)}`;
}
