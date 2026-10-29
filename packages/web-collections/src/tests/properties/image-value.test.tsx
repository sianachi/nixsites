import { useState, type ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { Item, PropertyDefinition } from '../../core/container-model';
import { PropertyInput } from '../../properties/property-input';

/**
 * The picture property's picker, exercised through the dispatch that chooses it.
 *
 * The states under test are the gallery card's ladder brought to the editor: nothing set, a value
 * that is not an address, a picture that loaded, and a picture that did not - each told apart in
 * words, because an empty box cannot say which of them it is. And the write discipline of every
 * other control here: an invalid address is refused in place and never written, and the same edit
 * is never written twice.
 */

const PICTURE = 'https://example.test/cover.png';
const CORRECTED = 'https://example.test/other.png';

function propertyOf(overrides: Partial<PropertyDefinition> & { key: string }): PropertyDefinition {
  return { label: overrides.key, type: 'image', options: [], required: false, ...overrides };
}

function itemWith(properties: Record<string, unknown>): Item {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    parentId: '33333333-3333-4333-8333-333333333333',
    type: 'note',
    title: 'Kickoff',
    hasChildren: false,
    seq: 1,
    lifecycleState: 'active',
    properties,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function coverProperty(): PropertyDefinition {
  return propertyOf({ key: 'cover', label: 'Cover' });
}

/**
 * The DataTransfer shape a drop handler reads, without a real drag to make one.
 *
 * `files` is part of it because a file drag is the case that carries no address at all - an empty
 * list is what every address-bearing drag has, and a non-empty one is the whole difference.
 */
function transferOf(
  entries: Record<string, string>,
  files: readonly unknown[] = [],
): { getData: (type: string) => string; files: readonly unknown[] } {
  return { getData: (type: string) => entries[type] ?? '', files };
}

describe('a picture property', () => {
  it('offers an address box and says a link can be pasted or dragged in', () => {
    render(<PropertyInput item={itemWith({})} property={coverProperty()} onCommit={vi.fn()} />);

    expect(screen.getByRole('textbox', { name: 'Cover' })).toHaveAttribute('type', 'url');

    // A link, not an image: there is no media model to upload a file into, and a hint that
    // invites the gesture is a hint that will be taken.
    expect(screen.getByText('Paste or drag in a link to a picture.')).toBeVisible();
  });

  it('says what works when a picture file is dragged in, rather than doing nothing', () => {
    const onCommit = vi.fn();

    render(<PropertyInput item={itemWith({})} property={coverProperty()} onCommit={onCommit} />);

    // A file drag carries neither of the address types, so the old handler fell through in
    // silence - after `onDragOver` had already painted the accent outline that says "accepted".
    fireEvent.drop(screen.getByRole('textbox', { name: 'Cover' }), {
      dataTransfer: transferOf({}, [{ name: 'cover.png' }]),
    });

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Pictures are added by address here. Drag in a link to a picture, or paste one.',
    );
  });

  it('says the same thing when a file is dropped onto a picture that is already set', () => {
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ cover: PICTURE })}
        property={coverProperty()}
        onCommit={onCommit}
      />,
    );

    fireEvent.drop(screen.getByRole('button', { name: 'Cover' }), {
      dataTransfer: transferOf({}, [{ name: 'cover.png' }]),
    });

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Pictures are added by address here. Drag in a link to a picture, or paste one.',
    );
  });

  it('stores a typed address on Enter', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(<PropertyInput item={itemWith({})} property={coverProperty()} onCommit={onCommit} />);

    const box = screen.getByRole('textbox', { name: 'Cover' });
    fireEvent.change(box, { target: { value: PICTURE } });
    await person.type(box, '{Enter}');

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(PICTURE);
  });

  it('stores a pasted address on the paste itself, without waiting for a blur', () => {
    const onCommit = vi.fn();

    render(<PropertyInput item={itemWith({})} property={coverProperty()} onCommit={onCommit} />);

    fireEvent.paste(screen.getByRole('textbox', { name: 'Cover' }), {
      clipboardData: transferOf({ 'text/plain': ` ${PICTURE} ` }),
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(PICTURE);
  });

  it('accepts a dropped image or link through its uri-list, skipping comment lines', () => {
    const onCommit = vi.fn();

    render(<PropertyInput item={itemWith({})} property={coverProperty()} onCommit={onCommit} />);

    fireEvent.drop(screen.getByRole('textbox', { name: 'Cover' }), {
      dataTransfer: transferOf({ 'text/uri-list': `# a comment\n${PICTURE}\n` }),
    });

    expect(onCommit).toHaveBeenCalledWith(PICTURE);
  });

  it('accepts a dropped address as plain text when no uri-list came along', () => {
    const onCommit = vi.fn();

    render(<PropertyInput item={itemWith({})} property={coverProperty()} onCommit={onCommit} />);

    fireEvent.drop(screen.getByRole('textbox', { name: 'Cover' }), {
      dataTransfer: transferOf({ 'text/plain': PICTURE }),
    });

    expect(onCommit).toHaveBeenCalledWith(PICTURE);
  });

  it('refuses an address that is not http or https, in place and without writing', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(<PropertyInput item={itemWith({})} property={coverProperty()} onCommit={onCommit} />);

    const box = screen.getByRole('textbox', { name: 'Cover' });
    await person.type(box, 'draft notes{Enter}');

    // The server's own sentence shape, said before the round trip; and the text stays on screen
    // to be corrected rather than being silently cleared or, worse, stored.
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Cover must be a link to an image, over http or https.',
    );
    expect(box).toHaveValue('draft notes');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('refuses a dropped scrap of text the same way, leaving it editable', () => {
    const onCommit = vi.fn();

    render(<PropertyInput item={itemWith({})} property={coverProperty()} onCommit={onCommit} />);

    fireEvent.drop(screen.getByRole('textbox', { name: 'Cover' }), {
      dataTransfer: transferOf({ 'text/plain': 'not an address' }),
    });

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Cover must be a link to an image, over http or https.',
    );
    expect(screen.getByRole('textbox', { name: 'Cover' })).toHaveValue('not an address');
  });

  it('shows the picture and its address once one is set', () => {
    const { container } = render(
      <PropertyInput
        item={itemWith({ cover: PICTURE })}
        property={coverProperty()}
        onCommit={vi.fn()}
      />,
    );

    // The thumbnail is decorative - the address beside it is the text - so it is found as an
    // element rather than by a role it deliberately does not have.
    const picture = container.querySelector('img');
    expect(picture).toHaveAttribute('src', PICTURE);

    const address = screen.getByRole('button', { name: 'Cover' });
    expect(address).toHaveTextContent(PICTURE);
    expect(address).toHaveAttribute('title', PICTURE);
  });

  it('returns to the address box, prefilled, when the address is clicked', async () => {
    const person = userEvent.setup();

    render(
      <PropertyInput
        item={itemWith({ cover: PICTURE })}
        property={coverProperty()}
        onCommit={vi.fn()}
      />,
    );

    await person.click(screen.getByRole('button', { name: 'Cover' }));

    // Focused as well as shown: the click asked for the editor, and leaving focus behind would
    // mean opening it and then having to find it.
    const box = screen.getByRole('textbox', { name: 'Cover' });
    expect(box).toHaveValue(PICTURE);
    expect(box).toHaveFocus();
  });

  it('removes the picture by writing null', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ cover: PICTURE })}
        property={coverProperty()}
        onCommit={onCommit}
      />,
    );

    await person.click(screen.getByRole('button', { name: 'Remove Cover' }));

    // Null, because that is what the contract's merge reads as "clear this one".
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it('offers to undo a removal, and puts the address back', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ cover: PICTURE })}
        property={coverProperty()}
        onCommit={onCommit}
      />,
    );

    await person.click(screen.getByRole('button', { name: 'Remove Cover' }));

    // Remove is one click and the address is off the screen entirely; nothing else holds it, so
    // the way back has to be here.
    expect(screen.queryByRole('button', { name: 'Remove Cover' })).not.toBeInTheDocument();
    await person.click(screen.getByRole('button', { name: 'Undo removing Cover' }));

    expect(onCommit).toHaveBeenNthCalledWith(1, null);
    expect(onCommit).toHaveBeenNthCalledWith(2, PICTURE);
  });

  it('withdraws the undo once the address is edited again', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    const { rerender } = render(
      <PropertyInput
        item={itemWith({ cover: PICTURE })}
        property={coverProperty()}
        onCommit={onCommit}
      />,
    );

    await person.click(screen.getByRole('button', { name: 'Remove Cover' }));
    rerender(<PropertyInput item={itemWith({})} property={coverProperty()} onCommit={onCommit} />);

    expect(screen.getByRole('button', { name: 'Undo removing Cover' })).toBeVisible();

    // An undo still offering an address two edits old is a trap, not a safety net.
    fireEvent.change(screen.getByRole('textbox', { name: 'Cover' }), {
      target: { value: CORRECTED },
    });

    expect(screen.queryByRole('button', { name: 'Undo removing Cover' })).not.toBeInTheDocument();
  });

  it('gives the address and the remove button the house control height, 44px on touch', () => {
    render(
      <PropertyInput
        item={itemWith({ cover: PICTURE })}
        property={coverProperty()}
        onCommit={vi.fn()}
      />,
    );

    const address = screen.getByRole('button', { name: 'Cover' });
    expect(address).toHaveClass('min-h-(--control-md)', 'any-pointer-coarse:min-h-(--control-lg)');

    const remove = screen.getByRole('button', { name: 'Remove Cover' });
    expect(remove).toHaveClass('h-(--control-md)', 'any-pointer-coarse:h-(--control-lg)');
  });

  it('moves focus to the address box after Remove, and back to the address after Undo', async () => {
    const person = userEvent.setup();

    function Stateful(): ReactNode {
      const [stored, setStored] = useState<unknown>(PICTURE);
      return (
        <PropertyInput
          item={itemWith({ cover: stored })}
          property={coverProperty()}
          onCommit={setStored}
        />
      );
    }
    render(<Stateful />);

    await person.click(screen.getByRole('button', { name: 'Remove Cover' }));
    expect(screen.getByRole('textbox', { name: 'Cover' })).toHaveFocus();

    await person.click(screen.getByRole('button', { name: 'Undo removing Cover' }));
    expect(screen.getByRole('button', { name: 'Cover' })).toHaveFocus();
  });

  it('dropping onto a set picture replaces it', () => {
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ cover: PICTURE })}
        property={coverProperty()}
        onCommit={onCommit}
      />,
    );

    fireEvent.drop(screen.getByRole('button', { name: 'Cover' }), {
      dataTransfer: transferOf({ 'text/uri-list': CORRECTED }),
    });

    expect(onCommit).toHaveBeenCalledWith(CORRECTED);
  });

  it('says a picture could not be loaded, in place, keeping the address editable', () => {
    const { container } = render(
      <PropertyInput
        item={itemWith({ cover: PICTURE })}
        property={coverProperty()}
        onCommit={vi.fn()}
      />,
    );

    const picture = container.querySelector('img');
    expect(picture).not.toBeNull();
    fireEvent.error(picture as Element);

    // Never the empty state: the property has a value, it is the fetch that broke.
    expect(screen.getByText('This picture could not be loaded. Check the address.')).toBeVisible();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('button', { name: 'Cover' })).toHaveTextContent(PICTURE);
  });

  it('announces the load failure, since it arrives after the picture was drawn', () => {
    const { container } = render(
      <PropertyInput
        item={itemWith({ cover: PICTURE })}
        property={coverProperty()}
        onCommit={vi.fn()}
      />,
    );

    fireEvent.error(container.querySelector('img') as Element);

    // The sentence is the live region, not a wrapper around it: the fetch fails asynchronously,
    // so a screen reader that has already read this control is otherwise never told.
    expect(screen.getByRole('status')).toHaveTextContent(
      'This picture could not be loaded. Check the address.',
    );

    // And it is not set quieter than the address beside it - this is the control failing.
    expect(screen.getByRole('status')).not.toHaveClass('text-muted');
  });

  it('heals a load failure by itself when the address is corrected', () => {
    const property = coverProperty();

    const { container, rerender } = render(
      <PropertyInput item={itemWith({ cover: PICTURE })} property={property} onCommit={vi.fn()} />,
    );

    fireEvent.error(container.querySelector('img') as Element);
    expect(screen.getByText('This picture could not be loaded. Check the address.')).toBeVisible();

    // The failure is keyed on the address that failed, so the corrected one is simply not it.
    rerender(
      <PropertyInput
        item={itemWith({ cover: CORRECTED })}
        property={property}
        onCommit={vi.fn()}
      />,
    );

    expect(
      screen.queryByText('This picture could not be loaded. Check the address.'),
    ).not.toBeInTheDocument();
    expect(container.querySelector('img')).toHaveAttribute('src', CORRECTED);
  });

  it('shows a stored value that is not an address as editable text, with the reason', () => {
    const { container } = render(
      <PropertyInput
        item={itemWith({ cover: 'draft notes' })}
        property={coverProperty()}
        onCommit={vi.fn()}
      />,
    );

    // A schema retype does not revalidate stored values, so this state is reachable without
    // anybody mistyping - and the value is never handed to an img to fetch against this origin.
    expect(screen.getByRole('textbox', { name: 'Cover' })).toHaveValue('draft notes');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Cover must be a link to an image, over http or https.',
    );
    expect(container.querySelector('img')).toBeNull();
  });

  it('does not write when the editor is left over an unchanged address', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ cover: PICTURE })}
        property={coverProperty()}
        onCommit={onCommit}
      />,
    );

    await person.click(screen.getByRole('button', { name: 'Cover' }));
    await person.tab();

    // Otherwise opening the editor to look and tabbing away writes the value it already holds.
    expect(onCommit).not.toHaveBeenCalled();

    // And the editor closes back to the picture, with focus returned to the address that opened
    // it rather than dropped on the floor.
    expect(screen.getByRole('button', { name: 'Cover' })).toHaveFocus();
  });

  it('shows the server refusal against the control it belongs to', () => {
    render(
      <PropertyInput
        item={itemWith({ cover: PICTURE })}
        property={coverProperty()}
        onCommit={vi.fn()}
        error="'cover' is required."
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent("'cover' is required.");
  });

  it('names its controls after the row at cell density and edits from the row', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ cover: PICTURE })}
        property={coverProperty()}
        onCommit={onCommit}
        density="cell"
      />,
    );

    // The column header is the label, so the controls name themselves after their row - a table
    // of twelve rows otherwise offers twelve controls all called "Cover".
    await person.click(screen.getByRole('button', { name: 'Cover for Kickoff' }));

    const box = screen.getByRole('textbox', { name: 'Cover for Kickoff' });
    expect(box).toHaveValue(PICTURE);

    fireEvent.change(box, { target: { value: CORRECTED } });
    await person.type(box, '{Enter}');

    expect(onCommit).toHaveBeenCalledWith(CORRECTED);
  });

  it('offers remove at cell density with the row in its name', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ cover: PICTURE })}
        property={coverProperty()}
        onCommit={onCommit}
        density="cell"
      />,
    );

    await person.click(screen.getByRole('button', { name: 'Remove Cover for Kickoff' }));

    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it('does not offer to change or remove anything when writing is not permitted', () => {
    render(
      <PropertyInput
        item={itemWith({ cover: PICTURE })}
        property={coverProperty()}
        onCommit={vi.fn()}
        disabled
      />,
    );

    expect(screen.getByRole('button', { name: 'Cover' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove Cover' })).toBeDisabled();
  });
});
