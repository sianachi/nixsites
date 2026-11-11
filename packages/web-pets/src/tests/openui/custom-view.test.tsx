import { createParser } from '@openuidev/react-lang';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { View } from '@nix/web-collections/core/container-model';
import type { ContainerData } from '@nix/web-collections/core/use-container';

const workspace = '11111111-1111-4111-8111-111111111111';
const collection = '22222222-2222-4222-8222-222222222222';
const client = { query: vi.fn(), execute: vi.fn(), invalidate: vi.fn() };
const run = vi.fn();

vi.mock('@nix/web-platform/api/api-client-provider', () => ({
  useApiClient: () => client,
  useOptionalApiClient: () => client,
}));
vi.mock('@nix/web-workspaces/workspaces/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: workspace }),
}));
vi.mock('@nix/companion', () => ({
  runWorkspaceTool: run,
  createCompanionBodies: () => ({}),
  defaultClock: () => ({}),
  defaultIds: () => ({}),
}));

const { default: CustomView } = await import('../../openui/custom-view');
const { nixLibrary } = await import('../../openui/library');
const { withContainer, STARTER_PROGRAM } = await import('../../openui/starter-program');

function customView(program: string | null): View {
  return {
    id: 'mine',
    name: 'Mine',
    kind: 'custom',
    columns: [],
    groupBy: null,
    groupOrder: [],
    dateProperty: null,
    sortBy: null,
    sortDescending: false,
    mode: null,
    coverProperty: null,
    endDateProperty: null,
    cardSize: null,
    layout: null,
    filters: [],
    program,
  };
}

function open(view: View) {
  const container = {
    itemId: collection,
    views: { views: [view] },
  } as unknown as ContainerData;
  render(
    <MemoryRouter>
      <CustomView container={container} view={view} onOpen={vi.fn()} />
    </MemoryRouter>,
  );
}

const stored = new Map<string, string>();

beforeEach(() => {
  vi.clearAllMocks();
  stored.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  run.mockResolvedValue({
    text: JSON.stringify({ items: [{ id: collection, title: 'Alpha', type: 'note' }] }),
    readOnly: true,
    touchedParents: [],
    lockedContent: false,
  });
});

describe('the starter program', () => {
  it('parses against the library once the collection is named', () => {
    const parser = createParser(nixLibrary.toJSONSchema());
    const result = parser.parse(withContainer(STARTER_PROGRAM, collection));
    expect(result.meta.errors).toEqual([]);
    expect(result.meta.unresolved).toEqual([]);
    expect(result.root).not.toBeNull();
  });
});

describe('a custom view', () => {
  it('reads the collection it is drawn in through `$container`', async () => {
    open(customView(STARTER_PROGRAM));
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    const [, ranIn, raw] = run.mock.calls[0] as [unknown, string, string];
    expect(ranIn).toBe(workspace);
    expect(JSON.parse(raw)).toMatchObject({ operation: 'list_items', parentId: collection });
  });

  it('names the collection in place, keeping every line where it was', () => {
    const named = withContainer('a = $container\nb = $containerX\nc = "$container"', collection);
    expect(named).toBe(`a = "${collection}"\nb = $containerX\nc = ""${collection}""`);
    expect(named.split('\n')).toHaveLength(3);
  });

  it('keeps changed values in this browser, per view', async () => {
    open(
      customView(
        'root = Stack([n, add])\nn = Text($count, "display")\nadd = Button("Add", @Set($count, $count + 1))\n$count = 0',
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }));
    expect(await screen.findByText('1')).toBeInTheDocument();
    expect(stored.get(`nix.openui.state.view:${collection}:mine`)).toContain('"$count":1');
  });

  it('points to the companion if a program does not render', async () => {
    open(customView('root = Marquee("nope")'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Ask your companion to fix it.');
    expect(screen.queryByRole('button', { name: 'Edit view' })).not.toBeInTheDocument();
  });
});
