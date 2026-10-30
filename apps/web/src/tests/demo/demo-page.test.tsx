import 'fake-indexeddb/auto';
import {
  companionBodies,
  conversations,
  createNixClient,
  habits,
  items,
  pets,
  search,
  structure,
  views,
  workspaces,
} from '@nix/api-client';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDemoFetch, DEMO_WORKSPACE, PRODUCT_LAUNCH } from '../../demo/demo-core';
import { DemoPage, prepareDemo } from '../../demo/demo-page';

const client = () =>
  createNixClient({
    baseUrl: 'https://demo.test',
    tokens: {
      getAccessToken: () => Promise.resolve('demo'),
      refreshAccessToken: () => Promise.resolve('demo'),
    },
    fetch: createDemoFetch(),
  });

const titlesUnder = async (
  nix: ReturnType<typeof client>,
  parentId?: string,
): Promise<string[]> => {
  const titles: string[] = [];
  for await (const item of nix.paginate(items.listItems(DEMO_WORKSPACE, { parentId })))
    titles.push(item.title);
  return titles;
};

const rootId = async (
  nix: ReturnType<typeof client>,
  title: string,
): Promise<string | undefined> => {
  for await (const item of nix.paginate(items.listItems(DEMO_WORKSPACE, {})))
    if (item.title === title) return item.id;
  return undefined;
};

/** The demo's Core answers the real API client from memory, and the app never reaches a server. */
describe('the demo', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('serves a workspace whose writes stick until the tab reloads', async () => {
    const nix = client();

    expect((await nix.query(workspaces.workspaceById(DEMO_WORKSPACE))).name).toBe(
      'Northwind Studio',
    );
    expect(await titlesUnder(nix)).toEqual([
      'Product launch',
      'Priorities',
      'Launch brief',
      'Plan launch week with Pip',
      'Habits',
      'Launch budget',
    ]);

    const created = await nix.execute(
      items.createItem(DEMO_WORKSPACE, {
        type: 'note',
        title: 'QA pass',
        parentId: PRODUCT_LAUNCH,
        properties: { status: 'To do' },
      }),
    );
    expect(created.properties).toEqual({ status: 'To do' });
    expect(await titlesUnder(nix, PRODUCT_LAUNCH)).toContain('QA pass');

    await nix.execute(items.deleteItem(DEMO_WORKSPACE, created.id));
    expect(await titlesUnder(nix, PRODUCT_LAUNCH)).not.toContain('QA pass');
    await nix.execute(items.restoreItem(DEMO_WORKSPACE, created.id));
    expect(await titlesUnder(nix, PRODUCT_LAUNCH)).toContain('QA pass');

    const board = await nix.execute(
      items.createStructuredItem(DEMO_WORKSPACE, {
        type: 'note',
        title: 'Reading list',
        parentId: null,
        schema: {
          properties: [
            {
              key: 'stage',
              label: 'Stage',
              type: 'select',
              options: ['Next', 'Done'],
              required: false,
            },
            // The wizard sends null choices for a field without any; Core stores an empty list.
            { key: 'notes', label: 'Notes', type: 'text', options: null, required: false },
          ],
          inherit: true,
        },
        views: {
          views: [{ id: 'board', name: 'Board', kind: 'board', groupBy: 'stage' }],
          default: 'board',
        },
        publishInteractiveFormViewId: null,
      } as Parameters<typeof items.createStructuredItem>[1]),
    );
    expect(await titlesUnder(nix)).toContain('Reading list');
    expect((await nix.query(views.containerViews(board.item.id))).default).toBe('board');
    const schema = await nix.query(structure.effectiveSchema(board.item.id));
    expect(schema.properties.map((property) => property.options)).toEqual([['Next', 'Done'], []]);

    // A fresh Core is a reload: the sample data again, without the visitor's edits.
    expect(await titlesUnder(client(), PRODUCT_LAUNCH)).not.toContain('QA pass');
  });

  it('opens on the sample board without a single network request', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('The demo must not reach the network'));
    vi.stubGlobal('fetch', fetch);

    await prepareDemo();
    render(<DemoPage />);

    expect(await screen.findByText('Press kit', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getAllByText('Product launch').length).toBeGreaterThan(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows a connected pet and a conversation that already happened', async () => {
    const nix = client();
    const { settings } = await nix.query(pets.settings());
    expect(settings.enabled).toBe(true);
    expect(settings.profiles[0]?.provider).toBe('anthropic');

    const chat = (await titlesUnder(nix)).includes('Plan launch week with Pip');
    expect(chat).toBe(true);
    const root = [];
    for await (const item of nix.paginate(items.listItems(DEMO_WORKSPACE, {}))) root.push(item);
    const itemId = root.find((item) => item.title === 'Plan launch week with Pip')?.id ?? '';
    const { items: messages } = await nix.query(conversations.messages(itemId));
    expect(messages).toHaveLength(6);
    expect(messages[1]?.text).toContain('Beta tester outreach](/w/');
    expect(messages[3]?.text).toContain('```openui-lang');
    expect(messages[5]?.text).toContain('Friday launches');
  });

  it('answers a new message with the scripted reply', async () => {
    vi.useFakeTimers();
    const nix = client();
    const root = [];
    for await (const item of nix.paginate(items.listItems(DEMO_WORKSPACE, {}))) root.push(item);
    const itemId = root.find((item) => item.title === 'Plan launch week with Pip')?.id ?? '';

    const sent = await nix.execute(
      conversations.send(itemId, { requestId: crypto.randomUUID(), text: 'Hello?' }),
    );
    expect(sent.turn?.status).toBe('running');
    await vi.advanceTimersByTimeAsync(1000);
    const { items: messages } = await nix.query(conversations.messages(itemId), {
      forceRefresh: true,
    });
    expect(messages.at(-2)?.text).toBe('Hello?');
    expect(messages.at(-1)?.text).toContain('my replies are scripted');
    vi.useRealTimers();
  });

  it('searches titles and note bodies for real matches', async () => {
    const nix = client();
    const titles = async (query: string) =>
      (await nix.query(search.searchItems(query, 20))).results.map((hit) => hit.title);

    const launch = await titles('launch');
    expect(launch).toEqual(
      expect.arrayContaining(['Product launch', 'Launch brief', 'Launch budget', 'Launch video']),
    );
    expect(await titles('beta sign-ups')).toContain('Launch brief');
    expect(await titles('zzzz')).toEqual([]);
    expect(await titles('la')).toEqual([]);
  });

  it('keeps habits with check-ins that can be changed', async () => {
    const nix = client();
    const habitItems = await titlesUnder(nix, (await rootId(nix, 'Habits')) ?? '');
    expect(habitItems).toEqual([
      'Morning run',
      'Read 20 pages',
      'Drink water',
      'Stretch before bed',
    ]);

    const id = await rootId(nix, 'Habits').then(async (habitsId) => {
      for await (const item of nix.paginate(
        items.listItems(DEMO_WORKSPACE, { parentId: habitsId }),
      ))
        if (item.title === 'Read 20 pages') return item.id;
      return '';
    });
    const range = [new Date(Date.now() - 6 * 86_400_000), new Date()].map((date) =>
      date.toISOString().slice(0, 10),
    );
    const before = await nix.query(habits.readHabit(id, range[0] ?? '', range[1] ?? ''), {
      forceRefresh: true,
    });
    expect(before.checkIns.length).toBeGreaterThan(3);
    expect(before.progress?.bestStreak).toBeGreaterThan(3);

    await nix.execute(habits.checkIn(id, range[1] ?? '', { completed: true, quantity: null }));
    const after = await nix.query(habits.readHabit(id, range[0] ?? '', range[1] ?? ''), {
      forceRefresh: true,
    });
    expect(after.checkIns.find((entry) => entry.occurredOn === range[1])?.completed).toBe(true);
  });

  it('holds an artifact whose body is an OpenUI program', async () => {
    const nix = client();
    const id = (await rootId(nix, 'Launch budget')) ?? '';
    expect((await nix.query(items.itemById(id))).type).toBe('artifact');

    const { updates } = await nix.query(companionBodies.bodyUpdates(id, '0'));
    expect(updates).toHaveLength(1);
    expect(
      (await nix.query(companionBodies.bodyUpdates('0199a000-0000-7000-8000-00000000ffff', '0')))
        .updates,
    ).toEqual([]);
  });
});
