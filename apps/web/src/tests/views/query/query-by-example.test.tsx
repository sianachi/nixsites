import {
  createInMemoryTokenStore,
  createNixClient,
  itemQueryResultsSchema,
  viewConfigurationSchema,
  views as coreViews,
} from '@nix/api-client';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { renderAt, signedIn } from '../../render-with-router';
import { aContainer, views } from '../../container-fixture';
import { aView } from '../../view-fixture';
import { STUB_WORKSPACE } from '../../api-stub';
import {
  ApiClientOverrideProvider,
  ApiClientProvider,
} from '@nix/web-platform/api/api-client-provider';
import { AuthProvider } from '@nix/web-platform/auth/auth-provider';
import {
  toViewRequest,
  type PropertyDefinition,
  type View,
} from '../../../views/core/container-model';
import { onItemChildrenChanged } from '@nix/web-foundation/lib/item-children-changed';
import type * as WorkspaceContextModule from '@nix/web-workspaces/workspaces/workspace-context';
import { describeInferredRule } from '../../../views/query/query-by-example';
import { QueryView } from '../../../views/query/query-view';

/**
 * Query by example, end to end over a stubbed run: tick the rows the list is meant to hold, ask for
 * filters, review them in the ordinary editor, and save through the ordinary view write - which is
 * the only moment the smart list changes.
 */

const SMART_LIST = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const WORKSPACE = 'dddddddd-4444-4444-8444-dddddddddddd';

vi.mock('@nix/web-workspaces/workspaces/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: WORKSPACE }),
  useOptionalWorkspace: () => ({ workspaceId: WORKSPACE }),
}));

const CATEGORY: PropertyDefinition = {
  key: 'category',
  label: 'Category',
  type: 'select',
  options: ['Bills', 'Errands', 'Health'],
  required: false,
};

const PRIORITY: PropertyDefinition = {
  key: 'priority',
  label: 'Priority',
  type: 'priority',
  options: [],
  required: false,
};

const LIST: View = aView({ id: 'query', name: 'Everything', kind: 'query', filters: [] });

function row(index: number, title: string, category: string): unknown {
  return {
    id: `bbbbbbbb-2222-4222-8222-${String(index).padStart(12, '0')}`,
    workspaceId: WORKSPACE,
    containerId: null,
    containerTitle: null,
    title,
    type: 'note',
    properties: { title, category },
  };
}

const ROWS = [
  row(1, 'Rent', 'Bills'),
  row(2, 'Water', 'Bills'),
  row(3, 'Groceries', 'Errands'),
  row(4, 'Dentist', 'Health'),
];

beforeEach(() => {
  signedIn();
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL) => {
      const url = typeof input === 'string' ? input : input.href;
      if (url.endsWith('/auth/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ accessToken: 'token', expiresAt: '2099-01-01T00:00:00.000Z' }),
            { headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            itemId: SMART_LIST,
            viewId: 'query',
            today: '2026-10-01',
            results: ROWS,
            limit: 500,
            truncated: false,
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    }),
  );
});

function renderList(setViews = vi.fn((): Promise<string | null> => Promise.resolve(null))) {
  renderAt(
    <AuthProvider>
      <ApiClientProvider>
        <QueryView
          container={aContainer({
            itemId: SMART_LIST,
            views: views([LIST]),
            setViews,
            schema: { properties: [CATEGORY, PRIORITY], declared: [], inherit: true },
          })}
          view={LIST}
          onOpen={vi.fn()}
        />
      </ApiClientProvider>
    </AuthProvider>,
  );
  return setViews;
}

async function tickAndSuggest(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Suggest filters from examples' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Use Rent as an example' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Use Water as an example' }));
  fireEvent.click(screen.getByRole('button', { name: 'Suggest filters' }));
}

describe('query by example', () => {
  it('proposes what the examples share into the filter editor, without saving it', async () => {
    const setViews = renderList();
    await tickAndSuggest();

    const panel = await screen.findByRole('region', { name: 'Filters suggested from examples' });
    expect(within(panel).getByText('Category is Bills - 2 of 4 remain')).toBeInTheDocument();
    // Focus moves to the proposal, so a keyboard or screen-reader user lands on what just appeared.
    expect(panel).toHaveFocus();
    expect(within(panel).getByRole('combobox', { name: 'Property' })).toHaveValue('category');
    expect(within(panel).getByRole('textbox', { name: 'Value' })).toHaveValue('Bills');
    expect(setViews).not.toHaveBeenCalled();
  });

  it('saves the reviewed rules through the view write and re-runs the list', async () => {
    const { WorkspaceProvider } = await vi.importActual<typeof WorkspaceContextModule>(
      '@nix/web-workspaces/workspaces/workspace-context',
    );
    const client = createNixClient({
      baseUrl: window.location.origin,
      tokens: createInMemoryTokenStore({
        initialAccessToken: 'query-by-example-test-token',
        refresh: () => Promise.resolve(null),
      }),
    });
    const storedSchema = z.object({
      views: z.array(viewConfigurationSchema),
      default: z.string(),
    });
    let stored = storedSchema.parse({
      views: [LIST],
      default: LIST.id,
    });
    const rows = itemQueryResultsSchema.shape.results.parse(ROWS);
    const requests: Request[] = [];
    const viewsPath = `/api/v1/items/${SMART_LIST}/views`;
    const queryPath = `/api/v1/items/${SMART_LIST}/query`;
    const response = (body: unknown): Response =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        // Node Request cannot accept jsdom's AbortSignal; preserve the other request data.
        const request =
          input instanceof Request ? input : new Request(input, { ...init, signal: null });
        requests.push(request);
        const url = new URL(request.url);
        if (url.pathname === viewsPath) {
          if (request.method !== 'PUT') throw new Error('The proposal must use the view write.');
          stored = storedSchema.parse(await request.json());
          return response({
            ...stored,
            views: stored.views.map(({ id, name, kind }) => ({ id, name, kind })),
            unrenderable: [],
          });
        }
        if (url.pathname === queryPath) {
          const rules = stored.views[0]?.filters ?? [];
          return response({
            itemId: SMART_LIST,
            viewId: url.searchParams.get('view'),
            today: url.searchParams.get('today'),
            results:
              rules.length === 0
                ? rows
                : rows.filter((candidate) =>
                    rules.every(
                      (rule) =>
                        rule.property === 'category' &&
                        rule.operator === 'equals' &&
                        candidate.properties.category === rule.value,
                    ),
                  ),
            limit: 500,
            truncated: false,
          });
        }
        throw new Error(`Unexpected Core request: ${request.method} ${url.pathname}`);
      }),
    );
    const setViews = async (next: readonly View[]): Promise<null> => {
      await client.execute(
        coreViews.setContainerViews(SMART_LIST, {
          views: next.map(toViewRequest),
          default: LIST.id,
        }),
      );
      return null;
    };
    renderAt(
      <ApiClientOverrideProvider client={client}>
        <Routes>
          <Route
            path="/w/:workspaceId"
            element={
              <WorkspaceProvider
                state={{
                  status: 'ready',
                  workspaces: [{ ...STUB_WORKSPACE, id: WORKSPACE }],
                  error: null,
                  reload: () => undefined,
                  workspaceCreated: () => undefined,
                  workspaceUpdated: () => undefined,
                  workspaceRemoved: () => undefined,
                }}
              >
                <QueryView
                  container={aContainer({
                    itemId: SMART_LIST,
                    views: views([LIST]),
                    setViews,
                    schema: { properties: [CATEGORY, PRIORITY], declared: [], inherit: true },
                  })}
                  view={LIST}
                  onOpen={vi.fn()}
                />
              </WorkspaceProvider>
            }
          />
        </Routes>
      </ApiClientOverrideProvider>,
      `/w/${WORKSPACE}`,
    );
    for (const title of ['Rent', 'Water', 'Groceries', 'Dentist'])
      expect(await screen.findByText(title)).toBeVisible();
    expect(requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
    await tickAndSuggest();
    const queryReads = requests.filter(
      (request) => new URL(request.url).pathname === queryPath,
    ).length;
    const changed = vi.fn();
    const stop = onItemChildrenChanged(changed);
    try {
      fireEvent.click(await screen.findByRole('button', { name: 'Save filters' }));
      await waitFor(() => {
        expect(stored.views[0]?.filters).toEqual([
          { property: 'category', operator: 'equals', value: 'Bills', any: null },
        ]);
        expect(
          screen.queryByRole('region', { name: 'Filters suggested from examples' }),
        ).not.toBeInTheDocument();
        expect(screen.getByText('Rent')).toBeVisible();
        expect(screen.getByText('Water')).toBeVisible();
        expect(screen.queryByText('Groceries')).not.toBeInTheDocument();
        expect(screen.queryByText('Dentist')).not.toBeInTheDocument();
      });
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 1_050));
      });
      expect(requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
      expect(
        requests.filter((request) => new URL(request.url).pathname === queryPath),
      ).toHaveLength(queryReads + 1);
      expect(changed).toHaveBeenCalledExactlyOnceWith({
        workspaceId: WORKSPACE,
        parentId: null,
        removedItemIds: [],
        restoredItemIds: [],
      });
    } finally {
      stop();
    }
  });

  it('keeps the proposal open and says why when the save is refused', async () => {
    renderList(vi.fn(() => Promise.resolve('That could not be saved.')));
    await tickAndSuggest();

    fireEvent.click(await screen.findByRole('button', { name: 'Save filters' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That could not be saved.');
    expect(
      screen.getByRole('region', { name: 'Filters suggested from examples' }),
    ).toBeInTheDocument();
  });

  it('discards the proposal without touching the list', async () => {
    const setViews = renderList();
    await tickAndSuggest();

    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));

    expect(
      screen.queryByRole('region', { name: 'Filters suggested from examples' }),
    ).not.toBeInTheDocument();
    expect(setViews).not.toHaveBeenCalled();
  });

  it('says so when the examples share nothing that narrows the list', async () => {
    renderList();
    fireEvent.click(await screen.findByRole('button', { name: 'Suggest filters from examples' }));
    // Every row ticked: nothing can narrow a list down to all of itself.
    for (const title of ['Rent', 'Water', 'Groceries', 'Dentist']) {
      fireEvent.click(screen.getByRole('checkbox', { name: `Use ${title} as an example` }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Suggest filters' }));

    expect(await screen.findByText(/there is no filter to suggest/)).toBeInTheDocument();
  });

  it('keeps one button label and says whether picking is on with aria-pressed', async () => {
    renderList();
    const toggle = await screen.findByRole('button', { name: 'Suggest filters from examples' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle);

    expect(screen.getByRole('button', { name: 'Suggest filters from examples' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('a proposed rule in words', () => {
  it('names the property by its label and a priority by its scale word', () => {
    expect(
      describeInferredRule(
        { property: 'priority', operator: 'equals', value: '1', remaining: 3 },
        10,
        [PRIORITY],
      ),
    ).toBe('Priority is 1 - Urgent - 3 of 10 remain');
  });

  it('falls back to the key for a property the schema does not declare', () => {
    expect(
      describeInferredRule(
        { property: 'mood', operator: 'not-equals', value: 'grim', remaining: 1 },
        2,
        [],
      ),
    ).toBe('mood is not grim - 1 of 2 remain');
  });

  it('names a person by the member lookup it is given, never by identifier', () => {
    const OWNER: PropertyDefinition = {
      key: 'owner',
      label: 'Owner',
      type: 'assignee',
      options: [],
      required: false,
    };
    expect(
      describeInferredRule(
        { property: 'owner', operator: 'equals', value: 'subject-7', remaining: 2 },
        5,
        [OWNER],
        (subject) => (subject === 'subject-7' ? 'Ada Lovelace' : 'someone else'),
      ),
    ).toBe('Owner is Ada Lovelace - 2 of 5 remain');
  });

  it('formats a timestamp rule’s compared calendar day', () => {
    const expected = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeZone: 'UTC',
    }).format(Date.UTC(2026, 8, 1));
    expect(
      describeInferredRule(
        { property: 'updatedAt', operator: 'on', value: '2026-09-01', remaining: 1 },
        2,
        [{ key: 'updatedAt', label: 'Updated', type: 'timestamp', options: [], required: false }],
      ),
    ).toBe(`Updated is on ${expected} - 1 of 2 remain`);
  });

  it.each(['equals', 'not-equals', 'on-or-after', 'before'] as const)(
    'writes a %s date rule in the reader’s date format, on the stored calendar day',
    (operator) => {
      const DUE: PropertyDefinition = {
        key: 'due',
        label: 'Due',
        type: 'date',
        options: [],
        required: false,
      };
      const expected = new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeZone: 'UTC',
      }).format(Date.UTC(2026, 8, 1));

      expect(
        describeInferredRule({ property: 'due', operator, value: '2026-09-01', remaining: 4 }, 9, [
          DUE,
        ]),
      ).toContain(`${expected} - 4 of 9 remain`);
    },
  );
});
