import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../../app';
import { item, STUB_WORKSPACE, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { aView } from '../../view-fixture';
import { memoryStorage } from '@nix/web-foundation/testing/memory-storage';
import { requestUrl } from '@nix/web-foundation/testing/request-url';

const DESTINATION = item({
  id: '4a4a4a4a-4444-4444-8444-4a4a4a4a4a4a',
  title: 'Product planning',
});

beforeEach(() => {
  signedIn();
  vi.stubGlobal('sessionStorage', memoryStorage());
});

function jsonRequestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') throw new Error('Expected the setup request to carry JSON.');
  return JSON.parse(init.body) as unknown;
}

function deferFetch(matches: (url: string, method: string) => boolean): {
  readonly release: () => void;
} {
  const originalFetch = fetch;
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (matches(url, method)) await gate;
      return await originalFetch(input, init);
    }),
  );
  return { release };
}

const CONFIGURED_SCHEMA = {
  properties: [
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: ['Planned', 'Shipped'],
      required: false,
    },
    { key: 'starts', label: 'Starts', type: 'timestamp', options: [], required: false },
    { key: 'ends', label: 'Ends', type: 'timestamp', options: [], required: false },
    { key: 'owner', label: 'Owner', type: 'text', options: [], required: false },
  ],
  declared: [],
  inherit: true,
} as const;

describe('the guided creation studio', () => {
  it('allows select options to be edited across lines without losing Enter or spaces', async () => {
    const user = userEvent.setup();
    stubCoreApi();
    renderAt(<App />, '/new/board');
    await screen.findByRole('heading', { name: /new board/i });
    const options = screen.getByRole('textbox', { name: 'Options' });
    await user.clear(options);
    await user.type(options, 'To do{Enter}In progress{Enter}Done');
    expect(options).toHaveValue('To do\nIn progress\nDone');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('textbox', { name: 'Options' })).toHaveValue(
      'To do\nIn progress\nDone',
    );
  });

  it('allows multiline form introductions, paragraph text and confirmation messages', async () => {
    const user = userEvent.setup();
    stubCoreApi();
    renderAt(<App />, '/new/interactive-form');
    await screen.findByRole('heading', { name: /new interactive form/i });
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: 'Add paragraph' }));
    for (const label of ['Introduction', 'Confirmation message', 'Text']) {
      const input = screen.getByRole('textbox', { name: label });
      await user.clear(input);
      await user.type(input, 'First line{Enter}Second line');
      expect(input).toHaveValue('First line\nSecond line');
    }
    const help = screen.getAllByRole('textbox', { name: 'Help text' })[0];
    if (help === undefined) throw new Error('Expected a field with help text.');
    await user.type(help, 'A hint{Enter}More detail');
    expect(help).toHaveValue('A hint\nMore detail');
  });

  it('keeps the chosen destination visible and restores an unfinished tab draft', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [DESTINATION] });
    const url = `/w/${STUB_WORKSPACE.id}/new/board?parent=${DESTINATION.id}`;
    const first = renderAt(<App />, url);

    expect(await screen.findByText(/creating in product planning/i)).toBeVisible();
    const name = screen.getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'Launch workflow');
    first.unmount();

    renderAt(<App />, url);
    expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveValue('Launch workflow');
  });

  it('starts Interactive Form with its full designer and a response companion', async () => {
    const user = userEvent.setup();
    stubCoreApi();
    renderAt(<App />, '/new/interactive-form');

    await screen.findByRole('heading', { name: /new interactive form/i });
    await user.click(screen.getByRole('button', { name: /continue/i }));

    expect(screen.getByRole('region', { name: /interactive form designer/i })).toBeVisible();
    expect(screen.getByRole('heading', { name: /form flow/i })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /publish a public response link/i })).toBeVisible();
    expect(screen.getByRole('combobox', { name: /companion/i })).toHaveValue('list');
  });

  it('loads an existing view into the same guided configuration flow', async () => {
    const view = aView({
      id: 'delivery-board',
      name: 'Delivery board',
      kind: 'board',
      groupBy: 'status',
      groupOrder: ['Planned', 'Shipped'],
    });
    stubCoreApi({
      items: [DESTINATION],
      views: { [DESTINATION.id]: { views: [view], default: view.id } },
    });

    renderAt(<App />, `/items/${DESTINATION.id}/views/${view.id}/edit/board`);

    expect(await screen.findByRole('heading', { name: /edit board/i })).toBeVisible();
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Delivery board');
    });
    expect(screen.getByRole('heading', { name: /delivery board/i })).toBeVisible();
  });

  it('preserves every field of an existing companion and uses edit-specific save copy', async () => {
    const user = userEvent.setup();
    const companion = aView({
      id: 'delivery-horizon',
      name: 'Delivery horizon',
      kind: 'timeline',
      columns: ['title', 'starts', 'owner'],
      dateProperty: 'starts',
      endDateProperty: 'ends',
      sortBy: 'owner',
      sortDescending: true,
      mode: 'quarter',
      filters: [{ property: 'status', operator: 'equals', value: 'Planned' }],
      companionViewId: null,
      companionPlacement: null,
      interactiveForm: null,
      measure: null,
      measureProperty: null,
      habitWidgets: [],
    });
    const primary = aView({
      id: 'delivery-board',
      name: 'Delivery board',
      kind: 'board',
      columns: ['title', 'status', 'owner'],
      groupBy: 'status',
      groupOrder: ['Planned', 'Shipped'],
      companionViewId: companion.id,
      companionPlacement: 'beside',
      interactiveForm: null,
      measure: null,
      measureProperty: null,
      habitWidgets: [],
    });
    stubCoreApi({
      items: [DESTINATION],
      schemas: { [DESTINATION.id]: CONFIGURED_SCHEMA },
      views: { [DESTINATION.id]: { views: [primary, companion], default: primary.id } },
    });
    const delayed = deferFetch(
      (url, method) =>
        method === 'PUT' && url.endsWith(`/view-setups/${encodeURIComponent(primary.id)}`),
    );

    renderAt(<App />, `/items/${DESTINATION.id}/views/${primary.id}/edit/board`);
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue(primary.name);
    });
    await user.click(screen.getByRole('button', { name: /continue/i }));

    expect(screen.getByRole('combobox', { name: /companion/i })).toHaveValue('timeline');
    expect(screen.getByRole('option', { name: companion.name })).toBeVisible();
    const placement = screen.getByRole('group', { name: 'Placement' });
    expect(within(placement).getByRole('button', { name: 'Side by side' })).toHaveAttribute(
      'aria-current',
      'true',
    );

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByRole('button', { name: 'Updating…' })).toBeDisabled();

    const request = vi
      .mocked(fetch)
      .mock.calls.find(
        ([input, init]) =>
          (init?.method ?? 'GET').toUpperCase() === 'PUT' &&
          requestUrl(input).endsWith(`/view-setups/${encodeURIComponent(primary.id)}`),
      );
    expect(request).toBeDefined();
    const body = jsonRequestBody(request?.[1]) as { views: readonly unknown[] };
    expect(body.views).toHaveLength(2);
    // Every field the fixtures carry, plus the arrangement lists and chart options the write
    // shape always sends.
    const arranged = {
      sorts: [],
      collapsedGroups: [],
      groupLimits: [],
      aggregates: [],
      doneProperty: null,
      rowBy: null,
      program: null,
      chart: null,
      open: null,
    };
    expect(body.views[0]).toEqual({ ...arranged, ...primary });
    expect(body.views[1]).toEqual({ ...arranged, ...companion });

    delayed.release();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    });
  });

  it('removes a companion in the same replacement that clears the primary composition fields', async () => {
    const user = userEvent.setup();
    const companion = aView({
      id: 'delivery-list',
      name: 'Delivery list',
      companionViewId: null,
      companionPlacement: null,
      interactiveForm: null,
      measure: null,
      measureProperty: null,
    });
    const primary = aView({
      id: 'delivery-board',
      name: 'Delivery board',
      kind: 'board',
      groupBy: 'status',
      groupOrder: ['Planned', 'Shipped'],
      companionViewId: companion.id,
      companionPlacement: 'below',
      interactiveForm: null,
      measure: null,
      measureProperty: null,
    });
    stubCoreApi({
      items: [DESTINATION],
      schemas: { [DESTINATION.id]: CONFIGURED_SCHEMA },
      views: { [DESTINATION.id]: { views: [primary, companion], default: primary.id } },
    });
    const delayed = deferFetch(
      (url, method) =>
        method === 'PUT' && url.endsWith(`/view-setups/${encodeURIComponent(primary.id)}`),
    );

    renderAt(<App />, `/items/${DESTINATION.id}/views/${primary.id}/edit/board`);
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue(primary.name);
    });
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.selectOptions(screen.getByRole('combobox', { name: /companion/i }), '');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    const request = vi
      .mocked(fetch)
      .mock.calls.find(
        ([input, init]) =>
          (init?.method ?? 'GET').toUpperCase() === 'PUT' &&
          requestUrl(input).endsWith(`/view-setups/${encodeURIComponent(primary.id)}`),
      );
    const body = jsonRequestBody(request?.[1]) as {
      views: readonly { companionViewId: string | null; companionPlacement: string | null }[];
    };
    expect(body.views).toHaveLength(1);
    expect(body.views[0]).toMatchObject({ companionViewId: null, companionPlacement: null });

    delayed.release();
  });

  it('uses create-specific button and progress copy for a new setup', async () => {
    const user = userEvent.setup();
    stubCoreApi();
    const delayed = deferFetch(
      (url, method) => method === 'POST' && url.endsWith('/structured-items'),
    );
    renderAt(<App />, '/new/list');

    await screen.findByRole('textbox', { name: 'Name' });
    await user.click(screen.getByRole('button', { name: 'Create List' }));
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled();

    delayed.release();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Creating…' })).not.toBeInTheDocument();
    });
  });

  it('uses add-specific button and progress copy for a new view on an existing item', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [DESTINATION] });
    const delayed = deferFetch((url, method) => method === 'POST' && url.endsWith('/view-setups'));
    renderAt(<App />, `/items/${DESTINATION.id}/views/new/list`);

    await screen.findByRole('heading', { name: 'Add List view' });
    await user.click(screen.getByRole('button', { name: 'Add List' }));
    expect(screen.getByRole('button', { name: 'Adding…' })).toBeDisabled();

    delayed.release();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Adding…' })).not.toBeInTheDocument();
    });
  });

  it('offers each configured property key once and prefers the nearest declared definition', async () => {
    const user = userEvent.setup();
    const localStage = {
      key: 'stage',
      label: 'Local stage',
      type: 'select',
      options: ['Planned', 'Done'],
      required: false,
    } as const;
    const localStatus = {
      key: 'status',
      label: 'Local status',
      type: 'select',
      options: ['Open', 'Closed'],
      required: false,
    } as const;
    const inheritedPriority = {
      key: 'priority',
      label: 'Inherited priority',
      type: 'select',
      options: ['High', 'Low'],
      required: false,
    } as const;
    const view = aView({
      id: 'workflow-board',
      name: 'Workflow',
      kind: 'board',
      groupBy: localStage.key,
      groupOrder: [...localStage.options],
    });
    stubCoreApi({
      items: [DESTINATION],
      schemas: {
        [DESTINATION.id]: {
          properties: [
            { ...localStatus, label: 'Effective status' },
            inheritedPriority,
            { ...localStage, label: 'Effective stage' },
          ],
          declared: [localStage, localStatus],
          inherit: true,
        },
      },
      views: { [DESTINATION.id]: { views: [view], default: view.id } },
    });
    renderAt(<App />, `/items/${DESTINATION.id}/views/${view.id}/edit/board`);

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue(view.name);
    });
    await user.click(screen.getByRole('button', { name: /continue/i }));

    const choice = screen.getByRole('combobox', { name: 'Group by' });
    const options = within(choice)
      .getAllByRole('option')
      .slice(1)
      .map((option) => [option.getAttribute('value'), option.textContent]);
    expect(options).toEqual([
      ['stage', 'Local stage'],
      ['status', 'Local status'],
      ['priority', 'Inherited priority'],
    ]);
    expect(new Set(options.map(([value]) => value)).size).toBe(options.length);
  });

  it('validates forward rail jumps and returns focus to the invalid field', async () => {
    const user = userEvent.setup();
    stubCoreApi();
    renderAt(<App />, '/new/board');

    const name = await screen.findByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.click(screen.getByRole('button', { name: /options: view, companion and sharing/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a name.');
    expect(name).toHaveFocus();
    expect(screen.getByRole('button', { name: /basics: name and fields/i })).toHaveAttribute(
      'aria-current',
      'step',
    );
  });

  it('moves focus to each new step heading and offers filters for list views', async () => {
    const user = userEvent.setup();
    stubCoreApi();
    renderAt(<App />, '/new/list');

    await user.click(await screen.findByRole('button', { name: /continue/i }));

    expect(screen.getByRole('heading', { name: /options/i })).toHaveFocus();
    expect(screen.getByRole('button', { name: /add a filter/i })).toBeVisible();
  });

  it.each(['board', 'gallery', 'calendar', 'timeline', 'sheet'])(
    'offers saved filters on the %s set-up step, because the view applies them',
    async (recipe) => {
      const user = userEvent.setup();
      stubCoreApi();
      renderAt(<App />, `/new/${recipe}`);

      await user.click(await screen.findByRole('button', { name: /continue/i }));

      expect(screen.getByRole('button', { name: /add a filter/i })).toBeVisible();
    },
  );

  it('keeps a field-name control mounted while its generated property key changes', async () => {
    const user = userEvent.setup();
    stubCoreApi();
    renderAt(<App />, '/new/board');

    const fieldName = await screen.findByRole('textbox', { name: 'Field name' });
    await user.clear(fieldName);
    await user.type(fieldName, 'Workflow status');

    expect(fieldName).toHaveValue('Workflow status');
    expect(fieldName).toHaveFocus();
  });

  it('gives both narrow-screen studio regions their own bounded scroller', async () => {
    stubCoreApi();
    renderAt(<App />, '/new/board');

    await screen.findByRole('heading', { name: /new board/i });
    const preview = screen.getByLabelText('Live preview');
    expect(preview.previousElementSibling).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto');
    expect(preview).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto', '@4xl/studio:flex-none');
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });

  it('opens the discard dialog on Escape', async () => {
    const user = userEvent.setup();
    stubCoreApi();
    renderAt(<App />, '/new/board');

    await user.click(await screen.findByRole('textbox', { name: 'Name' }));
    await user.keyboard('{Escape}');
    expect(await screen.findByRole('dialog', { name: 'Discard this setup?' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Discard this setup?' })).not.toBeInTheDocument();
    });
  });

  it('draws Required and the publish link as checkboxes', async () => {
    const user = userEvent.setup();
    stubCoreApi();
    renderAt(<App />, '/new/interactive-form');

    await screen.findByRole('heading', { name: /new interactive form/i });
    expect(screen.getAllByRole('checkbox', { name: 'Required' }).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByRole('checkbox', { name: /publish a public response link/i })).toBeVisible();
  });

  it('refuses malformed recovered data at the session boundary', async () => {
    sessionStorage.setItem(
      'nix:create:board:root',
      JSON.stringify({ title: 42, properties: 'not-fields', view: { kind: 'execute' } }),
    );
    stubCoreApi();
    renderAt(<App />, '/new/board');

    expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveValue('Untitled board');
  });
});
