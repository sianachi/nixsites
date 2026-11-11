import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLayoutEffect, useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Listbox, useListbox, type ListboxOption } from './Listbox';

const FRUIT: readonly ListboxOption[] = [
  { id: 'apple', label: 'Apple' },
  { id: 'apricot', label: 'Apricot' },
  { id: 'banana', label: 'Banana' },
];

/**
 * A caller, wired the way every real one is: a field that keeps the focus, a list that follows it.
 *
 * A real component rather than a `render` callback holding hooks - a callback is not a component,
 * so React's rules do not apply to it and the hooks would be a bug that happens to work.
 */
function Picker({
  options = FRUIT,
  onSelect = () => undefined,
  filter = false,
}: {
  readonly options?: readonly ListboxOption[];
  readonly onSelect?: (option: ListboxOption) => void;
  readonly filter?: boolean;
}): ReactNode {
  const [query, setQuery] = useState('');
  const shown = filter
    ? options.filter((option) => option.label.toLowerCase().includes(query.toLowerCase()))
    : options;
  const listbox = useListbox(shown, onSelect);

  return (
    <div>
      <input
        aria-label="Find a fruit"
        role="combobox"
        aria-expanded={listbox.expanded}
        aria-controls={listbox.id}
        aria-activedescendant={listbox.activeOptionId}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
        }}
        onKeyDown={listbox.onKeyDown}
      />
      <Listbox
        label="Fruit"
        options={shown}
        controller={listbox}
        emptyMessage="No fruit matches that."
      />
    </div>
  );
}

/** The option the highlight is on, read the way assistive technology reads it. */
function highlighted(): HTMLElement | undefined {
  return screen
    .getAllByRole('option')
    .find((option) => option.getAttribute('aria-selected') === 'true');
}

describe('a listbox driven from a text field', () => {
  it('keeps focus in the field and points at the highlighted option instead', async () => {
    // The property the whole component exists for. Moving focus into the list would take the
    // caret out of the field somebody is still typing into, and would announce every option as
    // whatever element it happened to be.
    const user = userEvent.setup();
    render(<Picker />);

    const field = screen.getByRole('combobox');
    await user.click(field);
    await user.keyboard('{ArrowDown}');

    expect(field).toHaveFocus();
    expect(field.getAttribute('aria-activedescendant')).toBe(highlighted()?.id);
  });

  it('starts on the first option so Enter alone commits the obvious answer', async () => {
    const chosen = vi.fn();
    const user = userEvent.setup();
    render(<Picker onSelect={chosen} />);

    await user.click(screen.getByRole('combobox'));
    await user.keyboard('{Enter}');

    expect(chosen).toHaveBeenCalledWith(FRUIT[0], 0);
  });

  it('moves the highlight down and up, and wraps at both ends', async () => {
    // A filtered list is short, and somebody holding the key expects to come back round rather
    // than stick against the end.
    const user = userEvent.setup();
    render(<Picker />);

    await user.click(screen.getByRole('combobox'));

    await user.keyboard('{ArrowUp}');
    expect(highlighted()).toHaveTextContent('Banana');

    await user.keyboard('{ArrowDown}');
    expect(highlighted()).toHaveTextContent('Apple');
  });

  it('leaves Home and End to the caret in the text being typed', async () => {
    // These moved the highlight at first, and taking them was worse than useless: in the reference
    // picker the same handler is bound to the editor itself, so from `[[` until the picker closed,
    // Home and End would have stopped working in the document.
    const user = userEvent.setup();
    render(<Picker />);

    const field = screen.getByRole('combobox');
    await user.click(field);
    await user.keyboard('{ArrowDown}');
    expect(highlighted()).toHaveTextContent('Apricot');

    await user.keyboard('{Home}');
    expect(highlighted()).toHaveTextContent('Apricot');

    await user.keyboard('{End}');
    expect(highlighted()).toHaveTextContent('Apricot');
  });

  it('brings the highlighted option into view, since focus never will', async () => {
    // jsdom performs no layout, so this asserts the call rather than the pixels - but the call is
    // the whole mechanism: with focus staying in the field, nothing else scrolls the list, and a
    // highlight below the fold means Enter commits something the person cannot see.
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    const user = userEvent.setup();
    render(<Picker />);

    await user.click(screen.getByRole('combobox'));
    scrollIntoView.mockClear();
    await user.keyboard('{ArrowDown}');

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('reports the popup as collapsed when there is nothing in it', async () => {
    // Every caller was hard-coding this true, which told assistive technology a list was open while
    // the person was reading "nothing matches".
    const user = userEvent.setup();
    render(<Picker filter />);

    const field = screen.getByRole('combobox');
    expect(field).toHaveAttribute('aria-expanded', 'true');

    await user.type(field, 'zzz');

    expect(field).toHaveAttribute('aria-expanded', 'false');
  });

  it('leaves every other key to the field it is attached to', async () => {
    // Attaching a key handler to somebody's text input and swallowing their typing is the failure
    // mode here, so it is asserted rather than assumed.
    const user = userEvent.setup();
    render(<Picker />);

    const field = screen.getByRole('combobox');
    await user.click(field);
    await user.keyboard('ap');

    expect(field).toHaveValue('ap');
  });

  it('does not handle Escape, so the innermost open layer can decide what closes', async () => {
    // The convention in the application is that the innermost open thing wins and stops the event.
    // A listbox that closed on Escape would take a dialog with it, or leave one behind.
    //
    // Asserted on the document, which is where the application's own layers listen, rather than on
    // a wrapper element - the wrapper would only prove the event was not stopped one node up.
    const escaped = vi.fn();
    document.addEventListener('keydown', escaped);
    const user = userEvent.setup();

    try {
      render(<Picker />);

      await user.click(screen.getByRole('combobox'));
      await user.keyboard('{Escape}');

      expect(escaped).toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', escaped);
    }
  });

  it('commits the option that was pressed', async () => {
    const chosen = vi.fn();
    const user = userEvent.setup();
    render(<Picker onSelect={chosen} />);

    await user.click(screen.getByRole('option', { name: /Banana/ }));

    expect(chosen).toHaveBeenCalledWith(FRUIT[2], 2);
  });

  it('selects the displayed option as soon as the list updates', () => {
    const chosen = vi.fn();
    function UpdatingPicker({ updated }: { readonly updated: boolean }): ReactNode {
      const options = updated ? FRUIT.slice(2) : FRUIT.slice(0, 1);
      const controller = useListbox(options, chosen);
      useLayoutEffect(() => {
        if (updated) {
          screen
            .getByRole('option', { name: 'Banana' })
            .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        }
      }, [updated]);
      return (
        <Listbox label="Fruit" options={options} controller={controller} emptyMessage="No fruit." />
      );
    }

    const { rerender } = render(<UpdatingPicker updated={false} />);
    rerender(<UpdatingPicker updated />);
    expect(chosen).toHaveBeenCalledExactlyOnceWith(FRUIT[2], 0);
  });

  it('brings the highlight back into range when the list shrinks under it', async () => {
    // Typing filters the list on every keystroke, so the highlight routinely points past the end
    // of what is left. Correcting it in an effect would leave one rendered frame - the one being
    // looked at - with a highlight on nothing.
    const user = userEvent.setup();
    render(<Picker filter />);

    const field = screen.getByRole('combobox');
    await user.click(field);
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(highlighted()).toHaveTextContent('Banana');

    await user.type(field, 'ap');

    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(highlighted()).toHaveTextContent('Apple');
  });

  it('says so when nothing matches, rather than showing an empty box', async () => {
    const user = userEvent.setup();
    render(<Picker filter />);

    await user.type(screen.getByRole('combobox'), 'zzz');

    expect(screen.getByRole('status')).toHaveTextContent('No fruit matches that.');
  });

  it('still resolves the field s aria-controls when nothing matches', async () => {
    // An id pointing at nothing is reported as a broken relationship rather than as "no results",
    // which is a worse answer than the empty list it was meant to avoid.
    const user = userEvent.setup();
    render(<Picker filter />);

    const field = screen.getByRole('combobox');
    await user.type(field, 'zzz');

    const controls = field.getAttribute('aria-controls') ?? '';
    expect(controls).not.toBe('');
    expect(document.getElementById(controls)).not.toBeNull();
    expect(field.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('owns each run of options as a named group, so an option says which list it came from', () => {
    // A listbox may own only options and groups. It also matters to a reader: in the palette the
    // heading is the only thing telling "run this command" from "open this document", and a bare
    // wrapper would have kept that visual-only.
    const grouped: readonly ListboxOption[] = [
      { id: 'go', label: 'Go to today', group: 'Commands' },
      { id: 'new', label: 'New note', group: 'Commands' },
      { id: 'plan', label: 'The plan', group: 'Items' },
    ];

    render(<Picker options={grouped} />);

    const groups = screen.getAllByRole('group');
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveAccessibleName('Commands');
    expect(groups[1]).toHaveAccessibleName('Items');

    const [commands, items] = groups;
    expect(commands === undefined ? [] : within(commands).getAllByRole('option')).toHaveLength(2);
    expect(items === undefined ? [] : within(items).getAllByRole('option')).toHaveLength(1);
  });

  it('gives the populated list a tab stop, since its options deliberately are not focusable', async () => {
    // What this buys, stated plainly: the caller's scroll container needs focusable content
    // somewhere inside it, and the options are unfocusable by design because the highlight travels
    // by `aria-activedescendant`. The route a person actually takes through the list is the arrow
    // keys from the field - a caller that dismisses the popup on blur never lets focus land here
    // at all. This Picker does not dismiss, so the stop is reachable and behaves.
    const user = userEvent.setup();
    render(<Picker />);

    await user.click(screen.getByRole('combobox'));
    await user.tab();

    expect(screen.getByRole('listbox')).toHaveFocus();
  });

  it('keeps an empty list out of the tab order', async () => {
    // The component deliberately stays mounted with nothing in it, so that `aria-controls` always
    // resolves. Left unconditional, the tab stop would turn that promise into a nameable,
    // focusable, do-nothing stop between the field and whatever comes after it - and there is
    // nothing to scroll, which was the tab stop's only reason to exist.
    const user = userEvent.setup();
    render(<Picker options={[]} />);

    const listbox = screen.getByRole('listbox');
    expect(listbox).not.toHaveAttribute('tabindex');

    await user.click(screen.getByRole('combobox'));
    await user.tab();
    expect(listbox).not.toHaveFocus();
  });

  it('answers to the same keys when the list itself holds the focus', async () => {
    // The tab stop is honest, not decorative: someone who lands on the list can still move the
    // highlight and commit, exactly as they could from the field.
    const chosen = vi.fn();
    const user = userEvent.setup();
    render(<Picker onSelect={chosen} />);

    const listbox = screen.getByRole('listbox');
    listbox.focus();

    await user.keyboard('{ArrowDown}');
    expect(highlighted()).toHaveTextContent('Apricot');
    expect(listbox.getAttribute('aria-activedescendant')).toBe(highlighted()?.id);

    await user.keyboard('{Enter}');
    expect(chosen).toHaveBeenCalledWith(FRUIT[1], 1);
  });

  it('does not hide the listbox element when it is empty', () => {
    // `hidden` is `display: none`, which removes the element from the accessibility tree - undoing
    // the `aria-controls` guarantee the empty element exists to provide.
    render(<Picker options={[]} />);

    const listbox = screen.getByRole('listbox');
    expect(listbox).toBeInTheDocument();
    expect(listbox).not.toHaveClass('hidden');
  });
});
