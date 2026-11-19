import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { itemSchema, type Item } from '@nix/api-client';
import { createFakePorts } from './testing/fake-ports.js';
import { runWorkspaceTool } from './run.js';
import { loadPreviewContext } from './context.js';
import { prepareNoteScopedTool, type NoteToolScope } from './scope.js';
import { workspaceToolSchema, type WorkspaceToolArgs } from './tool-args.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const rootId = '22222222-2222-4222-8222-222222222222';
const childId = '33333333-3333-4333-8333-333333333333';
const outsideId = '44444444-4444-4444-8444-444444444444';
const ancestorId = '55555555-5555-4555-8555-555555555555';
const scope: NoteToolScope = { rootItemId: rootId, readOnly: true };

function args(operation: WorkspaceToolArgs['operation'], extras: Partial<WorkspaceToolArgs> = {}) {
  return workspaceToolSchema.parse({
    operation,
    itemId: '',
    parentId: '',
    title: '',
    markdown: '',
    query: '',
    propertiesJson: '',
    specJson: '',
    ...extras,
  });
}

function item(id: string, parentId: string | null, title: string, extras: Partial<Item> = {}) {
  return itemSchema.parse({
    id,
    workspaceId,
    parentId,
    title,
    type: 'note',
    hasChildren: false,
    seq: 1,
    lifecycleState: 'active',
    properties: {},
    createdAt: '2026-10-11T00:00:00Z',
    updatedAt: '2026-10-11T00:00:00Z',
    ...extras,
  });
}

function setup() {
  const fake = createFakePorts();
  const tree = new Map([
    [rootId, item(rootId, ancestorId, 'Documentation', { hasChildren: true })],
    [childId, item(childId, rootId, 'Formula guide')],
    [outsideId, item(outsideId, null, 'Private workspace material')],
    [ancestorId, item(ancestorId, null, 'Private ancestor')],
  ]);
  fake.query.mockImplementation((endpoint: { operation: string; path: string }) => {
    if (endpoint.operation === 'schema.get')
      return Promise.resolve({ properties: [], declared: [], inherit: true });
    if (endpoint.operation === 'locks.get')
      return Promise.resolve({ locked: false, unlockedUntil: null, lockItemId: null });
    if (endpoint.operation === 'views.getConfigurations')
      return Promise.resolve({
        views: [],
        unrenderable: [],
        default: 'document',
        hideDocument: false,
      });
    const found = tree.get(endpoint.path.split('/').at(-1) ?? '');
    return found ? Promise.resolve(found) : Promise.reject(new Error('Core refused the item.'));
  });
  fake.paginate.mockImplementation(async function* (endpoint: { query: { parentId?: string } }) {
    await Promise.resolve();
    for (const row of tree.values()) if (row.parentId === endpoint.query.parentId) yield row;
  });
  fake.execute.mockResolvedValue(item(childId, rootId, 'New note'));
  fake.bodies.read.mockResolvedValue({ markdown: 'Scoped note content' });
  return { ...fake, tree };
}

describe('note-scoped workspace tools', () => {
  it('reads a descendant through fresh Core ancestry and forwards cancellation', async () => {
    const fake = setup();
    const outcome = await runWorkspaceTool(
      fake.ports,
      workspaceId,
      JSON.stringify(args('read_note', { itemId: childId })),
      fake.signal,
      { scope },
    );
    expect(JSON.parse(outcome.text)).toEqual({ markdown: 'Scoped note content' });
    expect(fake.bodies.read).toHaveBeenCalledWith(childId, fake.signal);
    for (const [endpoint, options] of fake.query.mock.calls) {
      expect(options).toMatchObject({ signal: fake.signal, forceRefresh: true });
      expect(endpoint).not.toMatchObject({ path: `/api/v1/items/${ancestorId}` });
    }
  });

  it('omits a withheld intermediate item while preserving access to its unmarked child', async () => {
    const fake = setup();
    const marked = item(childId, rootId, 'Sensitive formula', { hasChildren: true });
    fake.tree.set(childId, {
      ...marked,
      settings: { ...marked.settings, withholdFromPets: true },
    });
    fake.tree.set(outsideId, item(outsideId, childId, 'Shareable formula'));

    const outcome = await runWorkspaceTool(
      fake.ports,
      workspaceId,
      JSON.stringify(args('search', { query: 'formula' })),
      fake.signal,
      { scope },
    );
    expect(JSON.parse(outcome.text)).toMatchObject({
      results: [{ id: outsideId, title: 'Shareable formula' }],
    });
    expect(outcome.text).not.toContain('Sensitive formula');
  });

  it.each(['read_note', 'read_item', 'read_structure'] as const)(
    'refuses an outside %s before loading its body or structure',
    async (operation) => {
      const fake = setup();
      await expect(
        runWorkspaceTool(
          fake.ports,
          workspaceId,
          JSON.stringify(args(operation, { itemId: outsideId })),
          fake.signal,
          { scope },
        ),
      ).rejects.toThrow('outside that note');
      expect(fake.bodies.read).not.toHaveBeenCalled();
      expect(fake.query).not.toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'schema.get' }),
        expect.anything(),
      );
    },
  );

  it.each([
    args('create_note', { title: 'New note' }),
    args('append_note', { itemId: childId, markdown: 'More' }),
    args('rename_item', { itemId: childId, title: 'Renamed' }),
    args('trash_item', { itemId: childId }),
    args('set_properties', { itemId: childId, propertiesJson: '{}' }),
  ])('refuses a write in read-only scope before any I/O', async (tool) => {
    const fake = setup();
    await expect(
      runWorkspaceTool(fake.ports, workspaceId, JSON.stringify(tool), fake.signal, { scope }),
    ).rejects.toThrow('read only');
    expect(fake.query).not.toHaveBeenCalled();
    expect(fake.execute).not.toHaveBeenCalled();
    expect(fake.bodies.append).not.toHaveBeenCalled();
  });

  it.each([
    args('read_view', { itemId: rootId, query: '{"viewId":"list-1"}' }),
    args('read_calendar', { specJson: '{"from":"2026-10-01","to":"2026-10-11"}' }),
    args('list_templates'),
    args('read_template', { itemId: childId }),
  ])('refuses reads without a safe subtree contract', async (tool) => {
    const fake = setup();
    await expect(
      runWorkspaceTool(fake.ports, workspaceId, JSON.stringify(tool), fake.signal, { scope }),
    ).rejects.toThrow('cannot be limited');
    expect(fake.query).not.toHaveBeenCalled();
    expect(fake.paginate).not.toHaveBeenCalled();
  });

  it('defaults a listing to the note and never queries workspace roots', async () => {
    const fake = setup();
    const outcome = await runWorkspaceTool(
      fake.ports,
      workspaceId,
      JSON.stringify(args('list_items')),
      fake.signal,
      { scope },
    );
    expect(JSON.parse(outcome.text)).toEqual({
      items: [{ id: childId, title: 'Formula guide', type: 'note', hasChildren: false }],
      truncated: false,
    });
    expect(fake.paginate).toHaveBeenCalledWith(
      expect.objectContaining({ query: { parentId: rootId, includeDeleted: undefined } }),
      { signal: fake.signal, forceRefresh: true },
    );
  });

  it('refuses an explicit outside listing parent before listing it', async () => {
    const fake = setup();
    await expect(
      runWorkspaceTool(
        fake.ports,
        workspaceId,
        JSON.stringify(args('list_items', { parentId: outsideId })),
        fake.signal,
        { scope },
      ),
    ).rejects.toThrow('outside that note');
    expect(fake.paginate).not.toHaveBeenCalled();
  });

  it('refuses an unrelated item returned by a stale listing before sharing it', async () => {
    const fake = setup();
    fake.paginate.mockImplementation(async function* () {
      await Promise.resolve();
      yield item(outsideId, rootId, 'Stale private title');
    });
    await expect(
      runWorkspaceTool(fake.ports, workspaceId, JSON.stringify(args('list_items')), fake.signal, {
        scope,
      }),
    ).rejects.toThrow('outside that note');
    expect(fake.bodies.read).not.toHaveBeenCalled();
  });

  it('defaults a new note destination in both preview and execution', async () => {
    const fake = setup();
    const writableScope = { ...scope, readOnly: false };
    const tool = args('create_note', { title: 'New note' });
    const prepared = await prepareNoteScopedTool(
      fake.ports,
      workspaceId,
      tool,
      fake.signal,
      writableScope,
    );
    expect(prepared.parentId).toBe(rootId);
    const preview = await loadPreviewContext(
      fake.ports,
      workspaceId,
      tool,
      fake.signal,
      writableScope,
    );
    expect(preview.destination).toEqual({ title: 'Documentation', path: ['Documentation'] });
    await runWorkspaceTool(fake.ports, workspaceId, JSON.stringify(tool), fake.signal, {
      scope: writableScope,
    });
    expect(fake.execute.mock.calls[0]?.[0]).toMatchObject({
      operation: 'items.create',
      body: { parentId: rootId },
    });
  });

  it.each([
    { itemId: childId, parentId: outsideId },
    { itemId: childId, parentId: '' },
    { itemId: rootId, parentId: childId },
  ])('refuses a move that escapes or moves the scope root', async (ids) => {
    const fake = setup();
    await expect(
      runWorkspaceTool(
        fake.ports,
        workspaceId,
        JSON.stringify(args('move_item', ids)),
        fake.signal,
        { scope: { ...scope, readOnly: false } },
      ),
    ).rejects.toThrow();
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it('rejects a preview outside the note before it loads a body edit', async () => {
    const fake = setup();
    await expect(
      loadPreviewContext(
        fake.ports,
        workspaceId,
        args('replace_section', { itemId: outsideId, query: 'Heading', markdown: 'New' }),
        fake.signal,
        { ...scope, readOnly: false },
      ),
    ).rejects.toThrow('outside that note');
    expect(fake.bodies.planEdit).not.toHaveBeenCalled();
  });

  it('refuses a descendant that moved away after its preview', async () => {
    const fake = setup();
    const writableScope = { ...scope, readOnly: false };
    const tool = args('append_note', { itemId: childId, markdown: 'New text' });
    await loadPreviewContext(fake.ports, workspaceId, tool, fake.signal, writableScope);
    fake.tree.set(childId, item(childId, outsideId, 'Formula guide'));
    await expect(
      runWorkspaceTool(fake.ports, workspaceId, JSON.stringify(tool), fake.signal, {
        scope: writableScope,
      }),
    ).rejects.toThrow('outside that note');
    expect(fake.bodies.append).not.toHaveBeenCalled();
  });

  it('searches only live scoped titles and reports the limited search contract', async () => {
    const fake = setup();
    const outcome = await runWorkspaceTool(
      fake.ports,
      workspaceId,
      JSON.stringify(args('search', { query: 'formula' })),
      fake.signal,
      { scope },
    );
    expect(JSON.parse(outcome.text)).toMatchObject({
      results: [{ id: childId, title: 'Formula guide' }],
      scanned: 2,
      titlesOnly: true,
      truncated: false,
      partial: false,
    });
    expect(outcome.text).not.toContain('Private');
    expect(fake.query).not.toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'search.items' }),
      expect.anything(),
    );
  });

  it('refuses an outside UUID search without returning the item title', async () => {
    const fake = setup();
    await expect(
      runWorkspaceTool(
        fake.ports,
        workspaceId,
        JSON.stringify(args('search', { query: outsideId })),
        fake.signal,
        { scope },
      ),
    ).rejects.toThrow('outside that note');
  });

  it('marks a title search partial at the match bound', async () => {
    const fake = setup();
    fake.tree.delete(childId);
    for (let index = 0; index < 51; index += 1) {
      const id = `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`;
      fake.tree.set(id, item(id, rootId, 'Matching title'));
    }
    const outcome = await runWorkspaceTool(
      fake.ports,
      workspaceId,
      JSON.stringify(args('search', { query: 'matching' })),
      fake.signal,
      { scope },
    );
    const result = z
      .object({ results: z.array(z.unknown()), truncated: z.boolean(), partial: z.boolean() })
      .parse(JSON.parse(outcome.text));
    expect(result.results).toHaveLength(50);
    expect(result).toMatchObject({ truncated: true, partial: true });
  });

  it.each(['unreadable', 'different workspace', 'cycle'])(
    'fails closed when the ancestry is %s',
    async (failure) => {
      const fake = setup();
      if (failure === 'unreadable') fake.tree.delete(rootId);
      if (failure === 'different workspace')
        fake.tree.set(rootId, item(rootId, null, 'Elsewhere', { workspaceId: outsideId }));
      if (failure === 'cycle') fake.tree.set(childId, item(childId, childId, 'Loop'));
      await expect(
        runWorkspaceTool(
          fake.ports,
          workspaceId,
          JSON.stringify(args('read_note', { itemId: childId })),
          fake.signal,
          { scope },
        ),
      ).rejects.toThrow();
      expect(fake.bodies.read).not.toHaveBeenCalled();
    },
  );

  it('refuses ancestry beyond the bounded depth before reading a body', async () => {
    const fake = setup();
    let parentId = rootId;
    for (let index = 0; index < 128; index += 1) {
      const id = `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`;
      fake.tree.set(id, item(id, parentId, 'Deep note'));
      parentId = id;
    }
    await expect(
      runWorkspaceTool(
        fake.ports,
        workspaceId,
        JSON.stringify(args('read_note', { itemId: parentId })),
        fake.signal,
        { scope },
      ),
    ).rejects.toThrow('ancestry could not be confirmed');
    expect(fake.bodies.read).not.toHaveBeenCalled();
    expect(fake.query.mock.calls.length).toBeLessThanOrEqual(130);
  });
});
