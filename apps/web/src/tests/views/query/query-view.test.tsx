import { createNixClient } from '@nix/api-client';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderAt, signedIn } from '../../render-with-router';
import { aContainer } from '../../container-fixture';
import { aView } from '../../view-fixture';
import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import type { View } from '../../../views/core/container-model';
import { QueryView } from '../../../views/query/query-view';
import { ViewTools } from '../../../views/core/view-tools';
import { useViewState } from '../../../views/core/view-state';
import {
  hiddenItemsKey,
  readHiddenItems,
  writeHiddenItems,
} from '@nix/web-foundation/lib/view-hidden-items';

/**
 * The query view, driven against a stubbed run endpoint: the five states, the container names on
 * the rows, and the truncation sentence. The rows come from the server rather than from
 * `container.children`, which is the kind's whole point - so the stub is the endpoint, not the
 * container.
 */

const SMART_LIST = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ROW_ONE = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const ROW_TWO = 'cccccccc-3333-4333-8333-cccccccccccc';
const WORKSPACE = 'dddddddd-4444-4444-8444-dddddddddddd';
const TRACKER = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';

vi.mock('@nix/web-workspaces/workspaces/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: WORKSPACE }),
  useOptionalWorkspace: () => ({ workspaceId: WORKSPACE }),
}));

const OVERDUE_VIEW: View = aView({
  id: 'query',
  name: 'Overdue',
  kind: 'query',
  filters: [
    { property: 'due', operator: 'before', value: 'today' },
    { property: 'done', operator: 'not-equals', value: 'true' },
  ],
});

function row(id: string, title: string, due: string): unknown {
  return {
    id,
    workspaceId: WORKSPACE,
    containerId: TRACKER,
    containerTitle: 'Tracker',
    title,
    type: 'note',
    properties: { title, due },
  };
}

const DUE = { key: 'due', label: 'Due', type: 'date' as const, options: [], required: false };

/** `rowSchemas` maps a row container's id to the properties it declares; others answer 404. */
function stubRun(
  body: unknown,
  status = 200,
  rowSchemas: Readonly<Record<string, readonly unknown[]>> = {},
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL) => {
      const url = typeof input === 'string' ? input : input.href;
      const schemaOf = /\/items\/([^/]+)\/schema/.exec(url)?.[1];
      if (schemaOf !== undefined) {
        const declared = rowSchemas[schemaOf];
        return Promise.resolve(
          declared === undefined
            ? new Response('{}', {
                status: 404,
                headers: { 'content-type': 'application/problem+json' },
              })
            : new Response(JSON.stringify({ properties: declared, declared, inherit: true }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
        );
      }
      if (!url.includes('/query?view=')) {
        return Promise.reject(new Error(`Unexpected request: ${url}`));
      }
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: {
            'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
          },
        }),
      );
    }),
  );
}

function results(rows: readonly unknown[], truncated = false): unknown {
  return {
    itemId: SMART_LIST,
    viewId: 'query',
    today: '2026-08-15',
    results: rows,
    limit: 500,
    truncated,
  };
}

function renderQueryView(
  view: View = OVERDUE_VIEW,
  onOpen = vi.fn(),
  url = '/',
  container = aContainer({ itemId: SMART_LIST }),
): ReturnType<typeof vi.fn> {
  const client = createNixClient({
    baseUrl: window.location.origin,
    tokens: {
      getAccessToken: () => Promise.resolve('query-view-test-token'),
      refreshAccessToken: () => Promise.resolve(null),
    },
  });
  function Subject() {
    const state = useViewState();
    return (
      <>
        <ViewTools view={view} schema={[]} viewState={state} onSave={() => Promise.resolve(null)} />
        <QueryView container={container} view={view} onOpen={onOpen} />
      </>
    );
  }
  renderAt(
    <ApiClientOverrideProvider client={client}>
      <Subject />
    </ApiClientOverrideProvider>,
    url,
  );
  return onOpen;
}

beforeEach(() => {
  signedIn();
});

describe('the smart list', () => {
  it('searches only loaded titles and clears search without changing server filters', async () => {
    const user = userEvent.setup();
    stubRun(
      results(
        [row(ROW_ONE, 'Water plants', '2026-08-10'), row(ROW_TWO, 'Read', '2026-08-10')],
        true,
      ),
    );
    renderQueryView(OVERDUE_VIEW, vi.fn(), '/?search=missing');
    expect(
      await screen.findByText(
        'No loaded results match this title search. Clear the search above to see them.',
      ),
    ).toBeVisible();
    expect(screen.getByText(/the first 2 were loaded/)).toBeVisible();
    expect(screen.queryByText('All matches are hidden for you.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByRole('button', { name: 'Water plants' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Read' })).toBeVisible();
    // Row-schema reads are separate requests; the query itself must run once.
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([input]) =>
          (input instanceof URL
            ? input.href
            : typeof input === 'string'
              ? input
              : input.url
          ).includes('/query?view='),
        ),
    ).toHaveLength(1);
  });

  it('opens row actions through its context menu', async () => {
    const user = userEvent.setup();
    stubRun(results([row(ROW_ONE, 'Water plants', '2026-08-10')]));
    const onOpen = renderQueryView();
    const title = await screen.findByRole('button', { name: 'Water plants' });

    title.focus();
    fireEvent.contextMenu(title);
    await user.click(screen.getByRole('menuitem', { name: 'Open' }));
    expect(onOpen).toHaveBeenCalledWith(ROW_ONE);
    await vi.waitFor(() => {
      expect(title).toHaveFocus();
    });
  });

  it('offers hiding through row actions and recovery when every match is hidden', async () => {
    const user = userEvent.setup();
    const preference = hiddenItemsKey('test-subject', WORKSPACE);
    writeHiddenItems(preference, [ROW_TWO]);
    stubRun(results([row(ROW_ONE, 'Water plants', '2026-08-10')]));
    renderQueryView();
    await user.click(await screen.findByRole('button', { name: 'Actions for Water plants' }));
    await user.click(screen.getByRole('menuitem', { name: 'Hide for me' }));
    expect(screen.queryByRole('button', { name: 'Water plants' })).not.toBeInTheDocument();
    expect(screen.getByText('All matches are hidden for you.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show these results' }));
    expect(screen.getByRole('button', { name: 'Water plants' })).toBeInTheDocument();
    expect(readHiddenItems(preference)).toEqual([ROW_TWO]);
  });

  it('shows each match with the container it lives in and the values it matched on', async () => {
    stubRun(results([row(ROW_ONE, 'Water plants', '2026-08-10')]));
    renderQueryView();

    expect(await screen.findByRole('button', { name: 'Water plants' })).toBeInTheDocument();
    expect(screen.getByText('in Tracker')).toBeInTheDocument();
    expect(screen.getByText('2026-08-10')).toBeInTheDocument();
  });

  it("edits a matched value in place when the row's own container declares the property", async () => {
    stubRun(results([row(ROW_ONE, 'Water plants', '2026-08-10')]), 200, { [TRACKER]: [DUE] });
    renderQueryView();

    expect(await screen.findByRole('button', { name: /Due for Water plants/ })).toBeVisible();
  });

  it("does not edit a row with the smart list's schema when its own container lacks the property", async () => {
    stubRun(results([row(ROW_ONE, 'Water plants', '2026-08-10')]), 200, { [TRACKER]: [] });
    renderQueryView(
      OVERDUE_VIEW,
      vi.fn(),
      '/',
      aContainer({
        itemId: SMART_LIST,
        schema: { properties: [DUE], declared: [DUE], inherit: true },
      }),
    );

    expect(await screen.findByText('2026-08-10')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Due for Water plants/ })).not.toBeInTheDocument();
  });

  it('opens a row where it lives', async () => {
    stubRun(results([row(ROW_ONE, 'Water plants', '2026-08-10')]));
    const onOpen = renderQueryView();

    fireEvent.click(await screen.findByRole('button', { name: 'Water plants' }));

    expect(onOpen).toHaveBeenCalledWith(ROW_ONE);
  });

  it('says nothing matches today, rather than claiming the list is empty of items', async () => {
    stubRun(results([]));
    renderQueryView();

    expect(await screen.findByText('Nothing matches today')).toBeInTheDocument();
    expect(screen.getByText(/refills as items change/)).toBeInTheDocument();
  });

  it('says when the ceiling cut the list', async () => {
    stubRun(results([row(ROW_ONE, 'A', '2026-08-01'), row(ROW_TWO, 'B', '2026-08-02')], true));
    renderQueryView();

    expect(
      await screen.findByText(/More items match than this list carries: the first 2 were loaded\./),
    ).toBeInTheDocument();
  });

  it('reports a refusal in the server’s own terms and offers a retry', async () => {
    stubRun({ code: 'query.invalid_rules', detail: 'A stored filter no longer validates.' }, 422);
    renderQueryView();

    expect(
      await screen.findByText(/A stored filter no longer validates, so the query was not run/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('tells a routing 404 apart from a refusal', async () => {
    stubRun(null, 404);
    renderQueryView();

    expect(await screen.findByText(/the server does not offer/)).toBeInTheDocument();
  });
});
