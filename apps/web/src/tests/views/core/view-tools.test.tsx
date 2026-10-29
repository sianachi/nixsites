import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderAt } from '@nix/web-editor/testing/render-with-router';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';
import { aView } from '@nix/web-collections/testing/view-fixture';
import { filterGroup, type ViewFilterRule } from '@nix/web-collections/core/container-model';
import { ViewSwitcher } from '../../../views/core/view-switcher';
import { ViewTools } from '../../../views/core/view-tools';
import { useViewState } from '@nix/web-collections/core/view-state';

const rules: readonly ViewFilterRule[] = [
  filterGroup([
    { property: 'status', operator: 'equals', value: 'Doing' },
    { property: 'status', operator: 'equals', value: 'Done' },
  ]),
];

function Subject({
  onSave = () => Promise.resolve(null),
}: {
  readonly onSave?: (filters: readonly ViewFilterRule[]) => Promise<string | null>;
}) {
  const state = useViewState();
  return (
    <ViewTools
      view={aView({ filters: [...rules] })}
      schema={[{ key: 'status', label: 'Status', type: 'select' } as never]}
      viewState={state}
      onSave={onSave}
    />
  );
}

describe('view search and saved filters', () => {
  it('changes and clears title search without changing link filters', async () => {
    const user = userEvent.setup();
    renderAt(<Subject />, '/?f.status=Doing&search=Water');
    const search = screen.getByRole('searchbox', { name: 'Search titles' });
    expect(search).toHaveValue('Water');
    await user.clear(search);
    await user.type(search, 'Plants');
    expect(search).toHaveValue('Plants');
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Clear link filters (1)' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Clear link filters (1)' }));
    expect(search).toHaveFocus();
    expect(
      screen.queryByRole('button', { name: 'Clear link filters (1)' }),
    ).not.toBeInTheDocument();
  });

  it('preserves grouped rules and writes only when Save view filters is clicked', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.resolve(null));
    renderAt(<Subject onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: 'View options, 1 saved filters' }));
    expect(screen.getByRole('region', { name: 'Saved view filters' })).toHaveTextContent(
      'for everyone',
    );
    expect(onSave).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Save view filters' }));
    expect(onSave).toHaveBeenCalledExactlyOnceWith(rules);
    expect(screen.queryByRole('region', { name: 'Saved view filters' })).not.toBeInTheDocument();
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: 'View options, 1 saved filters' })).toHaveFocus(),
    );
  });

  it('keeps a refused draft visible and allows cancellation without writing again', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.resolve('You cannot edit this view.'));
    renderAt(<Subject onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: 'View options, 1 saved filters' }));
    await user.click(screen.getByRole('button', { name: 'Save view filters' }));
    expect(screen.getByRole('alert')).toHaveTextContent('You cannot edit this view.');
    expect(screen.getByRole('region', { name: 'Saved view filters' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('region', { name: 'Saved view filters' })).not.toBeInTheDocument();
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: 'View options, 1 saved filters' })).toHaveFocus(),
    );
  });

  it('keeps failed changes editable when saving unexpectedly throws', async () => {
    const user = userEvent.setup();
    renderAt(<Subject onSave={() => Promise.reject(new Error('Transport failed'))} />);
    await user.click(screen.getByRole('button', { name: 'View options, 1 saved filters' }));
    await user.click(screen.getByRole('button', { name: 'Save view filters' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Your changes are still here.');
    expect(screen.getByRole('button', { name: 'Save view filters' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('sets and clears the sort from the View options popover', async () => {
    const user = userEvent.setup();
    renderAt(<Subject />, '/?sort=status&dir=descending');
    await user.click(screen.getByRole('button', { name: 'View options, 1 saved filters' }));
    expect(screen.getByRole('combobox', { name: 'Sort by' })).toHaveValue('status');
    await user.click(screen.getByRole('button', { name: 'Ascending' }));
    expect(screen.getByRole('button', { name: 'Ascending' })).toHaveAttribute('aria-current');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort by' }), '');
    expect(screen.queryByRole('button', { name: 'Ascending' })).not.toBeInTheDocument();
  });

  it('keeps the filter draft when the popover is dismissed with Escape', async () => {
    const user = userEvent.setup();
    renderAt(<Subject />);
    await user.click(screen.getByRole('button', { name: 'View options, 1 saved filters' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'Saved view filters' })).not.toBeInTheDocument();
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: 'View options, 1 saved filters' })).toHaveFocus(),
    );
  });
});

describe('view search on a phone', () => {
  it('opens a focused field from the icon and closes it again while empty', async () => {
    stubViewport(false);
    const user = userEvent.setup();
    renderAt(<Subject />);
    const icon = screen.getByRole('button', { name: 'Search titles' });
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(icon).toHaveAttribute('aria-expanded', 'false');

    await user.click(icon);
    expect(icon).toHaveAttribute('aria-expanded', 'true');
    await vi.waitFor(() => expect(screen.getByRole('searchbox')).toHaveFocus());

    await user.click(icon);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('shows the field and Clear search when it arrives with search text', () => {
    stubViewport(false);
    renderAt(<Subject />, '/?search=Water');
    expect(screen.getByRole('searchbox')).toHaveValue('Water');
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeVisible();
  });

  it('puts the open search line after the item controls in the DOM, as it is drawn', () => {
    stubViewport(false);
    function Strip() {
      const state = useViewState();
      return (
        <ViewSwitcher
          views={[aView({ id: 'all', name: 'All' })]}
          unrenderable={[]}
          activeViewId="all"
          onSelect={vi.fn()}
          tools={
            <ViewTools
              placement="row"
              view={aView({ filters: [...rules] })}
              schema={[]}
              viewState={state}
              onSave={() => Promise.resolve(null)}
            />
          }
          trailing={<button type="button">Details</button>}
        />
      );
    }
    renderAt(<Strip />, '/?search=Water');

    const details = screen.getByRole('button', { name: 'Details' });
    const search = screen.getByRole('searchbox', { name: 'Search titles' });
    expect(details.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
