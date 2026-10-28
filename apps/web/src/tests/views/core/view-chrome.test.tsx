import { createNixClient, type NixClient } from '@nix/api-client';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { renderAt } from '../../render-with-router';
import { aContainer } from '../../container-fixture';
import type { Item, ViewFilterRule } from '../../../views/core/container-model';
import type { ContainerData } from '../../../views/core/use-container';
import {
  drawable,
  undrawable,
  useViewChrome,
  type Drawable,
} from '../../../views/core/view-chrome';
import { useViewState } from '../../../views/core/view-state';
import { ViewTools } from '../../../views/core/view-tools';

/**
 * The five states every view shares, exercised through a view that does nothing else.
 *
 * Driven at a URL rather than by handing filters in, because the filters live in the address and a
 * test that reached past it would be testing a function this application does not call.
 */

const NO_RULES: readonly ViewFilterRule[] = [];

function item(id: string, title: string, seq: number, properties: Record<string, unknown>): Item {
  return {
    id,
    workspaceId: 'workspace-1',
    parentId: 'folder-1',
    type: 'note',
    title,
    hasChildren: false,
    seq,
    lifecycleState: 'active',
    properties,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

const OPEN = item('item-o', 'Open one', 1, { status: 'open' });
const DONE = item('item-d', 'Done one', 2, { status: 'done' });

/**
 * A view with no opinions: it renders the chrome it is given, or the titles it is given.
 *
 * Deliberately anonymous - no landmark, no heading - so what the tests below see is exactly what
 * the shared chrome contributes and nothing the harness added.
 */
function Subject(props: {
  readonly container: ContainerData;
  readonly drawable?: Drawable<string>;
  readonly savedRules?: readonly ViewFilterRule[];
  readonly emptyAction?: ReactNode;
}): ReactNode {
  const viewState = useViewState();

  const chrome = useViewChrome({
    container: props.container,
    viewState,
    subject: 'this list',
    drawable: props.drawable ?? drawable('ready'),
    emptyTitle: 'Nothing in here yet',
    emptyDetail: 'Items added to this one appear here.',
    ...(props.emptyAction === undefined ? {} : { emptyAction: props.emptyAction }),
    view: { id: 'view-1', kind: 'list' },
    filtered: (total) => ({
      title: 'No items match the filters',
      detail: `This holds ${String(total)} items and the filters are hiding all of them.`,
    }),
    savedRules: props.savedRules ?? NO_RULES,
    sortBy: null,
    descending: false,
  });

  if (chrome.kind === 'chrome') {
    return (
      <>
        <ViewTools
          view={null}
          schema={[]}
          viewState={viewState}
          onSave={() => Promise.resolve(null)}
        />
        {chrome.node}
      </>
    );
  }

  return (
    <>
      {chrome.notice}
      <ul>
        {chrome.items.map((entry) => (
          <li key={entry.id}>{entry.title}</li>
        ))}
      </ul>
    </>
  );
}

describe('the shared view chrome', () => {
  it('searches after saved and link filters and clears search without widening those filters', async () => {
    const user = userEvent.setup();
    renderAt(
      <Subject container={aContainer({ children: [OPEN, DONE], truncated: true })} />,
      '/?f.status=open&search=missing',
    );
    expect(screen.getByRole('status')).toHaveTextContent('No loaded items match this title search');
    expect(screen.getByRole('status')).toHaveTextContent('More items have not been loaded.');
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByText('Open one')).toBeVisible();
    expect(screen.queryByText('Done one')).not.toBeInTheDocument();
    expect(screen.getByText(/hidden by the current filters/)).toBeVisible();
  });

  it('names title search separately from saved filters when it hides some loaded items', () => {
    renderAt(<Subject container={aContainer({ children: [OPEN, DONE] })} />, '/?search=OPEN');
    expect(screen.getByText('Open one')).toBeVisible();
    expect(screen.queryByText('Done one')).not.toBeInTheDocument();
    expect(screen.getByText(/hidden by the title search/)).toBeVisible();
  });

  it('tells loading apart from empty apart from filtered-to-nothing', () => {
    const { unmount } = renderAt(<Subject container={aContainer({ status: 'loading' })} />);

    expect(screen.getByText('Loading this list')).toBeVisible();
    expect(screen.queryByText('Nothing in here yet')).not.toBeInTheDocument();
    unmount();

    const empty = renderAt(<Subject container={aContainer({ children: [] })} />);

    expect(screen.getByRole('status')).toHaveTextContent('Nothing in here yet');
    expect(screen.queryByText('No items match the filters')).not.toBeInTheDocument();
    empty.unmount();

    renderAt(<Subject container={aContainer({ children: [OPEN, DONE] })} />, '/?f.status=archived');

    const filtered = screen.getByRole('status');
    expect(filtered).toHaveTextContent('No items match the filters');
    expect(filtered).toHaveTextContent('This holds 2 items');
    expect(filtered).not.toHaveTextContent('Nothing in here yet');
  });

  it('applies the rules saved on the view, and names them apart from the address filters', () => {
    renderAt(
      <Subject
        container={aContainer({ children: [OPEN, DONE] })}
        savedRules={[{ property: 'status', operator: 'equals', value: 'open' }]}
      />,
    );

    expect(screen.getByText('Open one')).toBeVisible();
    expect(screen.queryByText('Done one')).not.toBeInTheDocument();
    expect(screen.getByText(/hidden by this view's saved filters/)).toBeVisible();
  });

  it('does not offer to clear the address when the saved rules hide everything', () => {
    renderAt(
      <Subject
        container={aContainer({ children: [OPEN, DONE] })}
        savedRules={[{ property: 'status', operator: 'equals', value: 'archived' }]}
      />,
    );

    const panel = screen.getByRole('status');
    expect(panel).toHaveTextContent("No items match this view's filters");
    expect(panel).toHaveTextContent('hide all 2 of its items');
    // The link beside the sentence says where to go; the sentence does not repeat it.
    expect(panel).not.toHaveTextContent("Change them in the view's settings");
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  it('reports a container that could not be read instead of drawing an empty one', async () => {
    const user = userEvent.setup();
    const reload = vi.fn(() => Promise.resolve());

    renderAt(
      <Subject
        container={aContainer({ status: 'error', error: 'Core could not be reached.', reload })}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('This list could not be loaded');
    expect(alert).toHaveTextContent('Core could not be reached.');
    // The one thing a failure must never be mistaken for.
    expect(screen.queryByText('Nothing in here yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('says a view cannot be drawn in its own words, and does not call it empty', () => {
    renderAt(
      <Subject
        container={aContainer({ children: [OPEN] })}
        drawable={undrawable({
          title: 'This board groups by a property that no longer exists',
          detail: 'The items are all still here.',
        })}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('This board groups by a property that no longer exists');
    expect(alert).toHaveTextContent('The items are all still here.');
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('leaves the way out of a filter that hides everything on screen', async () => {
    const user = userEvent.setup();

    renderAt(<Subject container={aContainer({ children: [OPEN, DONE] })} />, '/?f.status=archived');

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(screen.getByText('Open one')).toBeVisible();
    expect(screen.getByText('Done one')).toBeVisible();
  });

  it('says how many items the filters are holding back rather than showing part of a list silently', () => {
    renderAt(<Subject container={aContainer({ children: [OPEN, DONE] })} />, '/?f.status=open');

    expect(screen.getByText('Open one')).toBeVisible();
    expect(screen.queryByText('Done one')).not.toBeInTheDocument();
    // Filters live only in the address, so nothing else on screen would say the other one is here.
    expect(screen.getByRole('status')).toHaveTextContent(
      'One more item is here and hidden by the current filters.',
    );
  });

  it('says nothing about hidden items when the filters are hiding none', () => {
    renderAt(<Subject container={aContainer({ children: [OPEN, DONE] })} />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it("links the saved-filter notice to this view's settings", () => {
    renderAt(
      <Subject
        container={aContainer({ children: [OPEN, DONE] })}
        savedRules={[{ property: 'status', operator: 'equals', value: 'open' }]}
      />,
    );

    expect(screen.getByRole('link', { name: "Change this view's filters" })).toHaveAttribute(
      'href',
      '/items/container-1/views/view-1/edit/list',
    );
  });

  it('links the hidden-everything panel to the settings, beside the way to add an item', () => {
    renderAt(
      <Subject
        container={aContainer({ children: [OPEN, DONE] })}
        savedRules={[{ property: 'status', operator: 'equals', value: 'archived' }]}
        emptyAction={<button type="button">Add an item</button>}
      />,
    );

    const panel = screen.getByRole('status');
    expect(panel).toContainElement(
      screen.getByRole('link', { name: "Change this view's filters" }),
    );
    expect(panel).toContainElement(screen.getByRole('button', { name: 'Add an item' }));
  });

  it('claims only the loaded items when a truncated container matches none of them', () => {
    renderAt(
      <Subject
        container={aContainer({ children: [OPEN, DONE], truncated: true })}
        savedRules={[{ property: 'status', operator: 'equals', value: 'archived' }]}
      />,
    );

    const panel = screen.getByRole('status');
    expect(panel).toHaveTextContent('None of the first 2 loaded items match');
    expect(panel).not.toHaveTextContent('hide all');
  });
});

describe('rules about the reader', () => {
  const ASSIGNED_TO_ME: readonly ViewFilterRule[] = [
    { property: 'owner', operator: 'equals', value: 'me' },
  ];
  const MINE = item('item-m', 'Mine', 1, { owner: '00000000-0000-4000-8000-0000000000aa' });
  const THEIRS = item('item-t', 'Theirs', 2, { owner: '00000000-0000-4000-8000-0000000000bb' });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function clientAnswering(me: () => Promise<Response>): NixClient {
    vi.stubGlobal('fetch', vi.fn(me));
    return createNixClient({
      baseUrl: 'https://nix.test',
      tokens: {
        getAccessToken: () => Promise.resolve('token'),
        refreshAccessToken: () => Promise.resolve('token'),
      },
    });
  }

  function renderWith(client: NixClient): void {
    renderAt(
      <ApiClientOverrideProvider client={client}>
        <Subject container={aContainer({ children: [MINE, THEIRS] })} savedRules={ASSIGNED_TO_ME} />
      </ApiClientOverrideProvider>,
    );
  }

  it("waits for the reader rather than showing nobody's items while they load", () => {
    renderWith(clientAnswering(() => new Promise<Response>(() => undefined)));

    expect(screen.getByText('Loading this list')).toBeInTheDocument();
    expect(screen.queryByText('Mine')).not.toBeInTheDocument();
    expect(screen.queryByText("No items match this view's filters")).not.toBeInTheDocument();
  });

  it('applies the rule once the reader is known', async () => {
    renderWith(
      clientAnswering(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              id: '00000000-0000-4000-8000-0000000000aa',
              tenantId: '00000000-0000-4000-8000-000000000001',
              displayName: 'Me',
              email: null,
              isTenantAdministrator: false,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      ),
    );

    expect(await screen.findByText('Mine')).toBeVisible();
    expect(screen.queryByText('Theirs')).not.toBeInTheDocument();
  });

  it('shows the items and says so when the reader could not be identified', async () => {
    renderWith(
      clientAnswering(() =>
        Promise.resolve(new Response(JSON.stringify({ title: 'Forbidden' }), { status: 403 })),
      ),
    );

    expect(await screen.findByText('Mine')).toBeVisible();
    expect(screen.getByText('Theirs')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Rules about you could not be checked, so they are not applied and more items may show.',
    );
  });
});
