import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CreateItemControl } from '../../../core/create-item-control';

/**
 * Making a child from inside a view.
 *
 * What is asserted here is the control's own behaviour. Where each view puts it, and which property
 * each one supplies, belongs to that view's suite - this is the part all three share.
 */

describe('the create control', () => {
  it('is closed until asked for', () => {
    render(<CreateItemControl label="Add an item to Doing" onCreate={vi.fn()} />);

    // A field in every column and every day would be forty inputs on a month view, every one of
    // them in the tab order and none of them wanted.
    expect(screen.getByRole('button', { name: 'Add an item to Doing' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('creates with the values the placement implies', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(() => Promise.resolve(null));

    render(
      <CreateItemControl
        label="Add an item to Doing"
        properties={{ status: 'Doing' }}
        onCreate={onCreate}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Add an item to Doing' }));
    await user.type(screen.getByRole('textbox'), 'Search ranking{Enter}');

    // The whole point: the item arrives already where it was asked for, rather than arriving loose
    // and being dragged there afterwards.
    expect(onCreate).toHaveBeenCalledWith('Search ranking', { status: 'Doing' });
  });

  it('refuses to create something with no name', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(() => Promise.resolve(null));

    render(<CreateItemControl label="Add an item" onCreate={onCreate} />);

    await user.click(screen.getByRole('button', { name: 'Add an item' }));
    await user.type(screen.getByRole('textbox'), '   {Enter}');

    // Whitespace is not a name. An item called "   " is one somebody has to find and rename before
    // they can tell it from the others.
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('stays open with the text still in it when the server refuses', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(() => Promise.resolve('Status must be one of Todo, Doing, Done.'));

    render(<CreateItemControl label="Add an item" onCreate={onCreate} />);

    await user.click(screen.getByRole('button', { name: 'Add an item' }));
    await user.type(screen.getByRole('textbox'), 'Search ranking{Enter}');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Status must be one of Todo, Doing, Done.',
    );

    // Closing on a refusal would throw away what was typed and leave somebody to work out what
    // happened from an empty screen.
    expect(screen.getByRole('textbox')).toHaveValue('Search ranking');
  });

  it('stays open and empties when it worked, because the next one usually follows', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(() => Promise.resolve(null));

    render(<CreateItemControl label="Add an item" onCreate={onCreate} />);

    await user.click(screen.getByRole('button', { name: 'Add an item' }));
    await user.type(screen.getByRole('textbox'), 'First{Enter}');

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toHaveValue('');
    });

    await user.type(screen.getByRole('textbox'), 'Second{Enter}');
    expect(onCreate).toHaveBeenNthCalledWith(2, 'Second', undefined);
  });

  it('closes on Escape and gives focus back to what opened it', async () => {
    const user = userEvent.setup();
    render(<CreateItemControl label="Add an item" onCreate={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Add an item' }));
    await user.keyboard('{Escape}');

    // Focus left on a field that no longer exists sends a keyboard back to the top of the document.
    await waitFor(() => {
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    // Re-queried rather than held: the field replaces the button while it is open, so the button
    // that comes back is a new element and a reference taken before the click is stale.
    expect(screen.getByRole('button', { name: 'Add an item' })).toHaveFocus();
  });

  it('adds no landmark, region or status of its own', () => {
    const { container } = render(<CreateItemControl label="Add an item" onCreate={vi.fn()} />);

    // The three view suites compare exact role inventories - the board its regions, the list its
    // row headers and a single cell, the calendar one status and one alert. An affordance that
    // introduced any of those would break assertions that are about the view, not about this.
    expect(container.querySelectorAll('[role="region"], [role="status"], section')).toHaveLength(0);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
