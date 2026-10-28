import type { NixClient } from '@nix/api-client';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { CreateItemControl } from '../../../views/core/create-item-control';
import type { CreateSuggestSource } from '../../../views/suggest/suggest-source';
import { useViewSuggestionPreference } from '@nix/web-foundation/lib/suggestion-preferences';
import { CATEGORY, WORKSPACE_ID, billsAndErrands } from './suggest-fixtures';

/**
 * The create control's suggestions, driven by typing a title.
 *
 * What is pinned is the principle the feature rests on: a suggestion writes nothing until it is
 * accepted, and an accepted value travels with the ordinary create rather than through a second
 * write. The workspace search is a stand-in client, so its failure can be made to happen.
 */

function sourceOf(onOpen = vi.fn()): CreateSuggestSource {
  return { children: billsAndErrands(), schema: [CATEGORY], onOpen };
}

function searchClient(answer: () => Promise<unknown>): NixClient {
  return { query: vi.fn(answer) } as unknown as NixClient;
}

async function openAndType(title: string): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Add an item' }));
  await user.type(screen.getByRole('textbox', { name: 'Add an item' }), title);
  return user;
}

beforeEach(() => {
  useViewSuggestionPreference.getState().setSetting('on');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('suggestions while creating an item', () => {
  it('offers the likely value with its reason, and sends it only once accepted', async () => {
    const onCreate = vi.fn(() => Promise.resolve(null));
    render(<CreateItemControl label="Add an item" onCreate={onCreate} suggest={sourceOf()} />);

    const user = await openAndType('Gas invoice');

    expect(
      await screen.findByText(/Suggested Category:/, undefined, { timeout: 2000 }),
    ).toHaveTextContent(
      "Suggested Category: Bills - 3 of the 3 items with 'invoice' in the title and a Category set use Bills.",
    );

    await user.click(screen.getByRole('button', { name: 'Use Bills for Category' }));
    expect(screen.getByText(/will be set to/)).toHaveTextContent('Category will be set to Bills.');

    await user.type(screen.getByRole('textbox', { name: 'Add an item' }), '{Enter}');
    expect(onCreate).toHaveBeenCalledWith('Gas invoice', { category: 'Bills' });
  });

  it('never applies a suggestion nobody accepted', async () => {
    const onCreate = vi.fn(() => Promise.resolve(null));
    render(<CreateItemControl label="Add an item" onCreate={onCreate} suggest={sourceOf()} />);

    const user = await openAndType('Gas invoice');
    await screen.findByRole('button', { name: 'Use Bills for Category' }, { timeout: 2000 });
    await user.type(screen.getByRole('textbox', { name: 'Add an item' }), '{Enter}');

    expect(onCreate).toHaveBeenCalledWith('Gas invoice', undefined);
  });

  it('takes an accepted value back on Undo', async () => {
    const onCreate = vi.fn(() => Promise.resolve(null));
    render(<CreateItemControl label="Add an item" onCreate={onCreate} suggest={sourceOf()} />);

    const user = await openAndType('Gas invoice');
    await user.click(
      await screen.findByRole('button', { name: 'Use Bills for Category' }, { timeout: 2000 }),
    );
    await user.click(screen.getByRole('button', { name: 'Do not set Category to Bills' }));
    await user.type(screen.getByRole('textbox', { name: 'Add an item' }), '{Enter}');

    expect(onCreate).toHaveBeenCalledWith('Gas invoice', undefined);
  });

  it('does not second-guess the value the placement sets', async () => {
    render(
      <CreateItemControl
        label="Add an item"
        properties={{ category: 'Errands' }}
        onCreate={vi.fn(() => Promise.resolve(null))}
        suggest={sourceOf()}
      />,
    );

    await openAndType('Gas invoice');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryByText(/Suggested Category/)).not.toBeInTheDocument();
  });

  it('says when a similar item already exists here, and opens it', async () => {
    const onOpen = vi.fn();
    const source = sourceOf(onOpen);
    render(<CreateItemControl label="Add an item" onCreate={vi.fn()} suggest={source} />);

    const user = await openAndType('Water invoices');
    expect(
      await screen.findByText(/A similar item already exists here/, undefined, { timeout: 2000 }),
    ).toHaveTextContent('A similar item already exists here: Water invoice');

    await user.click(
      screen.getByRole('button', { name: 'Open Water invoice (discards this draft)' }),
    );
    expect(onOpen).toHaveBeenCalledWith(source.children[1]?.id);
  });

  it('finds a similar item elsewhere in the workspace, ignoring other workspaces', async () => {
    const client = searchClient(() =>
      Promise.resolve({
        query: 'Renew passport',
        limit: 20,
        truncated: false,
        results: [
          { id: 'other-ws', workspaceId: 'someone-else', type: 'note', title: 'Renew passport' },
          { id: 'here', workspaceId: WORKSPACE_ID, type: 'note', title: 'Renew passports' },
        ],
      }),
    );
    const onOpen = vi.fn();
    render(
      <ApiClientOverrideProvider client={client}>
        <CreateItemControl label="Add an item" onCreate={vi.fn()} suggest={sourceOf(onOpen)} />
      </ApiClientOverrideProvider>,
    );

    const user = await openAndType('Renew passport');
    expect(
      await screen.findByText(/elsewhere in this workspace/, undefined, { timeout: 2000 }),
    ).toHaveTextContent('Renew passports');
    await user.click(
      screen.getByRole('button', { name: 'Open Renew passports (discards this draft)' }),
    );
    expect(onOpen).toHaveBeenCalledWith('here');
  });

  it('says nothing at all when the workspace search fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = searchClient(() => Promise.reject(new Error('offline')));
    render(
      <ApiClientOverrideProvider client={client}>
        <CreateItemControl label="Add an item" onCreate={vi.fn()} suggest={sourceOf()} />
      </ApiClientOverrideProvider>,
    );

    await openAndType('Renew passport');
    await waitFor(() => {
      expect(warn).toHaveBeenCalled();
    });
    // Not "no duplicates": a request that did not complete checked nothing.
    expect(screen.queryByText(/already exists/)).not.toBeInTheDocument();
    expect(screen.queryByText(/no duplicates|no similar/i)).not.toBeInTheDocument();
  });

  it('adds no landmark, region or status while suggesting', async () => {
    const { container } = render(
      <CreateItemControl label="Add an item" onCreate={vi.fn()} suggest={sourceOf()} />,
    );
    await openAndType('Gas invoice');
    await screen.findByRole('button', { name: 'Use Bills for Category' }, { timeout: 2000 });

    expect(container.querySelectorAll('[role="region"], [role="status"], section')).toHaveLength(0);
  });

  it('announces how many suggestions there are, not every line as it redraws', async () => {
    const { container } = render(
      <CreateItemControl label="Add an item" onCreate={vi.fn()} suggest={sourceOf()} />,
    );
    await openAndType('Gas invoice');
    await screen.findByRole('button', { name: 'Use Bills for Category' }, { timeout: 2000 });

    const live = container.querySelectorAll('[aria-live]');
    expect(live).toHaveLength(1);
    expect(live[0]).toHaveClass('sr-only');
    expect(live[0]).toHaveTextContent('1 suggestion for this item.');
  });

  it('suggests nothing when suggestions in views are switched off', async () => {
    useViewSuggestionPreference.getState().setSetting('off');
    render(<CreateItemControl label="Add an item" onCreate={vi.fn()} suggest={sourceOf()} />);

    await openAndType('Gas invoice');
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(screen.queryByText(/Suggested Category/)).not.toBeInTheDocument();
  });
});
