import { describe, expect, it, vi } from 'vitest';
import { createFakePorts } from './testing/fake-ports.js';
import { runWorkspaceTool } from './run.js';
import { structureFingerprint } from './guards.js';
import { loadPreviewContext } from './context.js';
import { readStructure } from './structure/read-structure.js';
import { WorkspaceToolRefusal, workspaceToolSchema } from './tool-args.js';

const workspace = '11111111-1111-4111-8111-111111111111';
const itemId = '22222222-2222-4222-8222-222222222222';
const input = (operation: string, extras = {}) =>
  JSON.stringify({
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
function setup() {
  const fake = createFakePorts();
  fake.query.mockImplementation((endpoint: { operation: string }) =>
    Promise.resolve(
      endpoint.operation === 'schema.get'
        ? { properties: [], declared: [], inherit: true }
        : endpoint.operation === 'views.getConfigurations' || endpoint.operation === 'views.get'
          ? { views: [], unrenderable: [], default: 'document', hideDocument: false }
          : { id: itemId, workspaceId: workspace, parentId: null, title: 'Plan', type: 'note' },
    ),
  );
  fake.execute.mockResolvedValue({ id: itemId, title: 'Plan' });
  fake.paginate.mockImplementation(async function* () {
    await Promise.resolve();
    yield { id: itemId, workspaceId: workspace, type: 'note', isDeleted: true };
  });
  return fake;
}
describe('workspace-scoped companion tools', () => {
  it.each(['list_views', 'query_view', 'create_view', 'delete_view'])(
    'refuses unsupported view operation %s without pretending it was executed',
    async (operation) => {
      const { ports, query, execute, bodies, signal } = setup();
      await expect(
        runWorkspaceTool(ports, workspace, input(operation, { itemId }), signal),
      ).rejects.toThrow();
      expect(query).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(bodies.append).not.toHaveBeenCalled();
    },
  );
  it('resolves UUID searches directly inside the current workspace', async () => {
    const { ports, query, signal } = setup();
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('search', { query: itemId }),
      signal,
    );
    const result = JSON.parse(outcome.text) as { results: { id: string }[] };
    expect(result.results[0]?.id).toBe(itemId);
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'items.get' }),
      expect.anything(),
    );
  });
  it.each([
    ['read_item', 'items.get'],
    ['read_structure', 'items.get'],
    ['rename_item', 'items.rename'],
    ['move_item', 'items.move'],
    ['set_properties', 'properties.set'],
    ['trash_item', 'items.delete'],
  ])('routes %s through the normal Nix client', async (operation, expected) => {
    const { ports, query, execute, signal } = setup();
    await runWorkspaceTool(
      ports,
      workspace,
      input(operation, { itemId, title: 'Renamed', propertiesJson: '{"status":"Done"}' }),
      signal,
    );
    expect([...query.mock.calls, ...execute.mock.calls]).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([expect.objectContaining({ operation: expected })]),
      ]),
    );
  });
  it.each(['read_note', 'append_note'])(
    'uses bounded note-body access for %s',
    async (operation) => {
      const { ports, bodies, signal } = setup();
      bodies.read.mockResolvedValue({ markdown: 'Existing', truncated: false });
      bodies.append.mockResolvedValue({ appended: true });
      await runWorkspaceTool(
        ports,
        workspace,
        input(operation, { itemId, markdown: 'Append only' }),
        signal,
      );
      expect(operation === 'read_note' ? bodies.read : bodies.append).toHaveBeenCalledOnce();
    },
  );
  it('reads a file item through the files port and sends its picture beside the text', async () => {
    const { ports, query, bodies, signal } = setup();
    query.mockResolvedValue({ id: itemId, workspaceId: workspace, title: 'Shot', type: 'file' });
    const read = vi.fn().mockResolvedValue({
      fileName: 'shot.png',
      mediaType: 'image/png',
      image: 'data:image/jpeg;base64,/9j/AA==',
      truncated: false,
    });
    const outcome = await runWorkspaceTool(
      { ...ports, files: { read } },
      workspace,
      input('read_note', { itemId }),
      signal,
    );
    expect(read).toHaveBeenCalledWith(itemId, signal);
    expect(bodies.read).not.toHaveBeenCalled();
    expect(outcome.image).toBe('data:image/jpeg;base64,/9j/AA==');
    expect(JSON.parse(outcome.text)).toEqual({
      id: itemId,
      title: 'Shot',
      type: 'file',
      fileName: 'shot.png',
      mediaType: 'image/png',
      truncated: false,
    });
  });
  it('refuses a file item where no files port can read it', async () => {
    const { ports, query, signal } = setup();
    query.mockResolvedValue({ id: itemId, workspaceId: workspace, title: 'Doc', type: 'file' });
    await expect(
      runWorkspaceTool(ports, workspace, input('read_note', { itemId }), signal),
    ).rejects.toThrow(WorkspaceToolRefusal);
  });
  it('bounds list results and tells the model when they are incomplete', async () => {
    const { ports, paginate, signal } = setup();
    paginate.mockImplementation(async function* () {
      await Promise.resolve();
      for (let i = 0; i < 60; i++)
        yield { id: itemId, workspaceId: workspace, type: 'note', isDeleted: false };
    });
    const outcome = await runWorkspaceTool(ports, workspace, input('list_items'), signal);
    const result = JSON.parse(outcome.text) as { items: unknown[]; truncated: boolean };
    expect(result.items).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });
  it('refuses restoration when the target is absent from this workspace trash', async () => {
    const { ports, paginate, execute, signal } = setup();
    paginate.mockImplementation(async function* () {
      await Promise.resolve();
      yield { id: itemId, workspaceId: 'another-workspace', type: 'note', isDeleted: true };
    });
    await expect(
      runWorkspaceTool(ports, workspace, input('restore_item', { itemId }), signal),
    ).rejects.toThrow('not found');
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects a foreign destination before creating anything', async () => {
    const { ports, query, execute, signal } = setup();
    query.mockResolvedValue({ workspaceId: 'another-workspace' });
    await expect(
      runWorkspaceTool(
        ports,
        workspace,
        input('create_note', { parentId: itemId, title: 'No' }),
        signal,
      ),
    ).rejects.toThrow('outside');
    expect(execute).not.toHaveBeenCalled();
  });
  it('does not retry a failed mutation', async () => {
    const { ports, execute, signal } = setup();
    execute.mockRejectedValue(new Error('connection lost'));
    await expect(
      runWorkspaceTool(
        ports,
        workspace,
        input('rename_item', { itemId, title: 'No retry' }),
        signal,
      ),
    ).rejects.toThrow('connection lost');
    expect(execute).toHaveBeenCalledOnce();
  });
  it('restores an item from workspace trash even though ordinary item reads hide it', async () => {
    const { ports, query, execute, paginate, signal } = setup();
    await runWorkspaceTool(ports, workspace, input('restore_item', { itemId }), signal);
    expect(query).not.toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'items.get' }),
      expect.anything(),
    );
    expect(paginate).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'items.trash' }),
      expect.anything(),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'items.restore' }),
      expect.anything(),
    );
  });
  it('creates content and returns its identity to the model', async () => {
    const { ports, execute, bodies, signal } = setup();
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('create_note', { title: 'Plan', markdown: '# Plan\n\n- First task' }),
      signal,
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(bodies.append).toHaveBeenCalledWith(itemId, '# Plan\n\n- First task', signal);
    expect(JSON.parse(outcome.text)).toMatchObject({ id: itemId, contentConfirmed: true });
  });
  it('reports partial creation honestly and never retries the create', async () => {
    const { ports, execute, bodies, signal } = setup();
    bodies.append.mockRejectedValue(new Error('connection lost'));
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('create_note', { title: 'Plan', markdown: 'Body' }),
      signal,
    );
    expect(JSON.parse(outcome.text)).toMatchObject({
      id: itemId,
      created: true,
      contentConfirmed: false,
    });
    expect(execute).toHaveBeenCalledOnce();
  });
  it.each(['read_note', 'append_note', 'rename_item', 'move_item', 'set_properties', 'trash_item'])(
    'rejects cross-workspace %s before access or mutation',
    async (operation) => {
      const { ports, query, execute, bodies, signal } = setup();
      query.mockResolvedValue({ workspaceId: 'another-workspace', type: 'note' });
      await expect(
        runWorkspaceTool(
          ports,
          workspace,
          input(operation, {
            itemId,
            title: 'Changed',
            markdown: 'New text',
            propertiesJson: '{}',
          }),
          signal,
        ),
      ).rejects.toThrow('outside this workspace');
      expect(execute).not.toHaveBeenCalled();
      expect(bodies.read).not.toHaveBeenCalled();
      expect(bodies.append).not.toHaveBeenCalled();
    },
  );
  it('filters search results before sending data to the model', async () => {
    const { ports, query, signal } = setup();
    const passage = { itemId, title: 'Trip', heading: 'Plan', ord: 0, text: 'Holiday in May.' };
    query.mockImplementation((endpoint: { path: string; query?: Record<string, unknown> }) =>
      Promise.resolve(
        endpoint.path === '/api/v1/search/passages'
          ? { passages: endpoint.query?.workspaceId === workspace ? [passage] : [] }
          : {
              results: [
                { id: 'allowed', workspaceId: workspace },
                { id: 'private', workspaceId: 'other' },
              ],
              truncated: true,
            },
      ),
    );
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('search', { query: 'plan' }),
      signal,
    );
    expect(outcome.text).not.toContain('private');
    expect(JSON.parse(outcome.text)).toMatchObject({ truncated: true, passages: [passage] });
  });
  describe('remember', () => {
    const settings = (extra: Record<string, unknown> = {}) => ({
      revision: 7,
      settings: {
        enabled: true,
        activePetId: null,
        motion: 'system',
        profiles: [],
        inlineWriting: false,
        memories: [{ id: itemId, text: 'Works in London.', createdAt: '2026-10-29T00:00:00.000Z' }],
        memoryMode: 'ask',
        ...extra,
      },
    });
    const remember = (
      ports: ReturnType<typeof setup>['ports'],
      fact: string,
      signal: AbortSignal,
    ) => runWorkspaceTool(ports, workspace, input('remember', { markdown: fact }), signal);

    it('adds the fact at the revision it read', async () => {
      const { ports, query, execute, signal } = setup();
      query.mockResolvedValue(settings());
      const outcome = await remember(ports, '  Prefers   metric units. ', signal);
      expect(JSON.parse(outcome.text)).toEqual({ remembered: 'Prefers metric units.' });
      const saved = execute.mock.calls[0]?.[0] as {
        body: { expectedRevision: number; settings: { memories: { text: string }[] } };
      };
      expect(saved.body.expectedRevision).toBe(7);
      expect(saved.body.settings.memories.map((memory) => memory.text)).toEqual([
        'Works in London.',
        'Prefers metric units.',
      ]);
    });

    it('saves nothing for a fact it already has, or when memory is off', async () => {
      const { ports, query, execute, signal } = setup();
      query.mockResolvedValue(settings());
      expect(JSON.parse((await remember(ports, 'works in london.', signal)).text)).toMatchObject({
        alreadyKnown: true,
      });
      query.mockResolvedValue(settings({ memoryMode: 'off' }));
      await expect(remember(ports, 'Likes tea.', signal)).rejects.toThrow('turned memory off');
      expect(execute).not.toHaveBeenCalled();
    });
  });
  describe('find_action and run_action', () => {
    const action = (id: string, extras: Record<string, unknown> = {}) =>
      input('run_action', { query: id, specJson: JSON.stringify(extras) });

    it('finds actions by plain words and never offers a credential', async () => {
      const { ports, query, signal } = setup();
      const found = await runWorkspaceTool(
        ports,
        workspace,
        input('find_action', { query: 'bookmark a note' }),
        signal,
      );
      expect(found.readOnly).toBe(true);
      expect((JSON.parse(found.text) as { actions: unknown[] }).actions).toContainEqual(
        expect.objectContaining({ id: 'KeepItem', method: 'PUT' }),
      );
      const tokens = await runWorkspaceTool(
        ports,
        workspace,
        input('find_action', { query: 'create access token' }),
        signal,
      );
      expect(tokens.text).not.toContain('AccessToken');
      expect(query).not.toHaveBeenCalled();
    });

    it('runs an action after checking its item, and reports the item as touched', async () => {
      const { ports, query, execute, signal } = setup();
      execute.mockResolvedValue({ ok: true });
      const outcome = await runWorkspaceTool(
        ports,
        workspace,
        action('KeepItem', { path: { itemId } }),
        signal,
      );
      expect(query).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0]?.[0]).toMatchObject({
        method: 'PUT',
        path: `/api/v1/items/${itemId}/bookmark`,
      });
      expect(outcome).toMatchObject({ readOnly: false, touchedParents: [itemId] });
    });

    it('refuses credentials, unknown actions, bad parameters and other workspaces', async () => {
      const { ports, execute, signal } = setup();
      for (const call of [
        action('CreateAccessToken', { body: { name: 'x' } }),
        action('NoSuchAction'),
        action('KeepItem'),
        action('KeepItem', { path: { itemId, extra: 'x' } }),
        action('GetWorkspace', { path: { workspaceId: itemId } }),
      ])
        await expect(runWorkspaceTool(ports, workspace, call, signal)).rejects.toBeInstanceOf(
          WorkspaceToolRefusal,
        );
      expect(execute).not.toHaveBeenCalled();
    });

    it('keeps every workspace, item and site the request names inside this conversation', async () => {
      const { ports, query, execute, signal } = setup();
      const other = '33333333-3333-4333-8333-333333333333';
      // A body naming another workspace: the generic path cannot move items out.
      await expect(
        runWorkspaceTool(
          ports,
          workspace,
          action('MoveItem', {
            path: { itemId },
            body: { parentId: null, afterId: null, workspaceId: other },
          }),
          signal,
        ),
      ).rejects.toThrow('another workspace');
      // A site owned by another workspace.
      query.mockResolvedValue({ id: other, workspaceId: other, rootItemId: other });
      await expect(
        runWorkspaceTool(
          ports,
          workspace,
          action('PublishSite', { path: { siteId: other } }),
          signal,
        ),
      ).rejects.toThrow('another workspace');
      // An item named only in the body still goes through the item check.
      query.mockReset();
      query.mockRejectedValue(new WorkspaceToolRefusal('not here'));
      await expect(
        runWorkspaceTool(
          ports,
          workspace,
          action('RunWorkspaceQuery', {
            path: { workspaceId: workspace },
            body: { rootItemId: other },
          }),
          signal,
        ),
      ).rejects.toThrow('not here');
      expect(execute).not.toHaveBeenCalled();
    });

    it('treats a query sent as POST as locked content too', async () => {
      const { ports, execute, signal } = setup();
      execute.mockResolvedValue({ results: [] });
      const outcome = await runWorkspaceTool(
        ports,
        workspace,
        action('RunWorkspaceQuery', { path: { workspaceId: workspace }, body: {} }),
        signal,
      );
      expect(outcome.lockedContent).toBe(true);
    });

    it('treats a read through an action as locked content', async () => {
      const { ports, query, signal } = setup();
      query.mockResolvedValue({ id: itemId, workspaceId: workspace, parentId: null });
      const outcome = await runWorkspaceTool(
        ports,
        workspace,
        action('GetWorkspace', { path: { workspaceId: workspace } }),
        signal,
      );
      expect(outcome.lockedContent).toBe(true);
    });
  });
  describe('move_item to another workspace', () => {
    const other = '33333333-3333-4333-8333-333333333333';
    const move = (destination: string) =>
      input('move_item', {
        itemId,
        specJson: JSON.stringify({ destinationWorkspaceId: destination }),
      });

    it('sends the destination workspace when Core offers it', async () => {
      const { ports, execute, paginate, signal } = setup();
      paginate.mockImplementation(async function* () {
        await Promise.resolve();
        yield { id: other, name: 'Other' };
      });
      await runWorkspaceTool(ports, workspace, move(other), signal);
      expect(execute.mock.calls[0]?.[0]).toMatchObject({
        body: { parentId: null, workspaceId: other },
      });
    });

    it('refuses a workspace Core does not offer', async () => {
      const { ports, execute, paginate, signal } = setup();
      paginate.mockImplementation(async function* () {
        await Promise.resolve();
        yield { id: itemId, name: 'Elsewhere' };
      });
      await expect(runWorkspaceTool(ports, workspace, move(other), signal)).rejects.toBeInstanceOf(
        WorkspaceToolRefusal,
      );
      expect(execute).not.toHaveBeenCalled();
    });
  });
  it('refuses unknown operations and model-provided URLs', async () => {
    const { ports, execute, signal } = setup();
    await expect(runWorkspaceTool(ports, workspace, input('shell'), signal)).rejects.toThrow();
    await expect(
      runWorkspaceTool(
        ports,
        workspace,
        input('read_note', { itemId: 'https://example.com' }),
        signal,
      ),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it('refuses a wrongly shaped blueprint with its listed problems before writing', async () => {
    const { ports, execute, signal } = setup();
    const raw = input('build_blueprint', { parentId: itemId, specJson: '{"version":1}' });
    const preview = await loadPreviewContext(
      ports,
      workspace,
      workspaceToolSchema.parse(JSON.parse(raw)),
      signal,
    );
    const refusal = runWorkspaceTool(ports, workspace, raw, signal, {
      fence: preview.fingerprint,
    });
    await expect(refusal).rejects.toBeInstanceOf(WorkspaceToolRefusal);
    await expect(refusal).rejects.toThrow('title');
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([undefined, 'a'.repeat(64)])(
    'refuses template saving when the complete approval fence is missing or stale (%s)',
    async (fence) => {
      const { ports, query, execute, signal } = setup();
      query.mockImplementation((endpoint: { operation: string; path?: string }) => {
        if (endpoint.operation !== 'templates.capture.preview')
          throw new Error(`unexpected query ${endpoint.operation}`);
        const excluded = endpoint.path?.includes('excludeSampleDescendants=true');
        return Promise.resolve({
          fingerprint: 'c'.repeat(64),
          captureFingerprint: excluded ? 'd'.repeat(64) : 'c'.repeat(64),
          sourceTitle: 'Plan',
          itemCount: excluded ? 2 : 3,
        });
      });
      await expect(
        runWorkspaceTool(
          ports,
          workspace,
          input('save_as_template', { itemId, title: 'Saved', specJson: '{}' }),
          signal,
          { toolId: 'tool', claimId: 'claim', ...(fence ? { fence } : {}) },
        ),
      ).rejects.toThrow('source changed');
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it('refuses a blueprint build with a stale or missing approval fence before writing', async () => {
    const { ports, execute, signal } = setup();
    const raw = input('build_blueprint', {
      parentId: itemId,
      specJson: JSON.stringify({
        version: 1,
        title: 'Reading log',
        summary: 'Track books.',
        root: { id: 'reading-log', title: 'Reading log' },
      }),
    });
    for (const options of [{}, { fence: 'stale' }]) {
      await expect(runWorkspaceTool(ports, workspace, raw, signal, options)).rejects.toThrow(
        'destination changed since you approved',
      );
    }
    expect(execute).not.toHaveBeenCalled();
  });
  it('builds a blueprint when the approved destination fingerprint is current', async () => {
    const { ports, execute, signal } = setup();
    const raw = input('build_blueprint', {
      parentId: itemId,
      specJson: JSON.stringify({
        version: 1,
        title: 'Reading log',
        summary: 'Track books.',
        root: { id: 'reading-log', title: 'Reading log' },
      }),
    });
    const preview = await loadPreviewContext(
      ports,
      workspace,
      workspaceToolSchema.parse(JSON.parse(raw)),
      signal,
    );
    const outcome = await runWorkspaceTool(ports, workspace, raw, signal, {
      fence: preview.fingerprint,
    });
    expect(JSON.parse(outcome.text)).toMatchObject({ complete: true });
    expect(execute).toHaveBeenCalledOnce();
  });
  it('refuses a blueprint build when Pet drafts is replaced after preview', async () => {
    const { ports, execute, paginate, signal } = setup();
    const firstSandbox = '33333333-3333-4333-8333-333333333333';
    const replacement = '44444444-4444-4444-8444-444444444444';
    let sandboxId = firstSandbox;
    paginate.mockImplementation(async function* () {
      await Promise.resolve();
      yield {
        id: sandboxId,
        workspaceId: workspace,
        parentId: null,
        title: 'Pet drafts',
        type: 'note',
      };
    });
    const raw = input('build_blueprint', {
      specJson: JSON.stringify({
        version: 1,
        title: 'Reading log',
        summary: 'Track books.',
        root: { id: 'reading-log', title: 'Reading log' },
      }),
    });
    const preview = await loadPreviewContext(
      ports,
      workspace,
      workspaceToolSchema.parse(JSON.parse(raw)),
      signal,
    );
    sandboxId = replacement;
    await expect(
      runWorkspaceTool(ports, workspace, raw, signal, {
        fence: preview.fingerprint,
      }),
    ).rejects.toThrow('destination changed since you approved');
    expect(execute).not.toHaveBeenCalled();
  });
  it('names the destination of a create_note in touchedParents', async () => {
    const { ports, signal } = setup();
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('create_note', { title: 'Plan', parentId: itemId }),
      signal,
    );
    expect(outcome.touchedParents).toEqual([itemId]);
    expect(outcome.readOnly).toBe(false);
  });
  it('reports no touched parent and read-only for a read operation', async () => {
    const { ports, signal } = setup();
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('read_item', { itemId }),
      signal,
    );
    expect(outcome.touchedParents).toEqual([]);
    expect(outcome.readOnly).toBe(true);
  });

  it('checks every destination ancestor before reading that ancestor schema', async () => {
    const { ports, query, signal } = setup();
    const ancestorId = '33333333-3333-4333-8333-333333333333';
    query.mockImplementation((endpoint: { operation: string; path: string }) => {
      if (endpoint.operation === 'items.get') {
        const id = endpoint.path.split('/').at(-1);
        return Promise.resolve({
          id,
          workspaceId: id === itemId ? workspace : 'foreign',
          parentId: id === itemId ? ancestorId : null,
          title: id === itemId ? 'Parent' : 'Outside parent',
        });
      }
      if (endpoint.operation === 'schema.get')
        return Promise.resolve({ properties: [], declared: [], inherit: true });
      throw new Error(`unexpected query ${endpoint.operation}`);
    });
    const args = {
      operation: 'create_entries',
      itemId: '',
      parentId: itemId,
      title: '',
      markdown: '',
      query: '',
      propertiesJson: '',
      specJson: '{"entries":[{"title":"A"}]}',
    } as const;
    await expect(loadPreviewContext(ports, workspace, args, signal)).rejects.toThrow(
      'outside this workspace',
    );
    expect(
      query.mock.calls.map(([endpoint]) => (endpoint as { operation: string }).operation),
    ).toEqual(['items.get', 'items.get']);
  });

  it('refuses a cross-workspace legacy target before loading its structure', async () => {
    const { ports, query, signal } = setup();
    query.mockResolvedValue({
      id: itemId,
      workspaceId: 'foreign',
      parentId: null,
      title: 'Outside',
      type: 'note',
    });
    const args = {
      operation: 'rename_item',
      itemId,
      parentId: '',
      title: 'Next',
      markdown: '',
      query: '',
      propertiesJson: '',
      specJson: '',
    } as const;
    await expect(loadPreviewContext(ports, workspace, args, signal)).rejects.toThrow('outside');
    expect(
      query.mock.calls.map(([endpoint]) => (endpoint as { operation: string }).operation),
    ).toEqual(['items.get']);
  });

  it('passes apply_template inputs from specJson through to preflight and apply', async () => {
    const { ports, query, execute, signal } = setup();
    query.mockImplementation((endpoint: { operation: string }) => {
      if (endpoint.operation === 'templates.list')
        return Promise.resolve({ templates: [{ id: itemId }], capabilities: { canManage: true } });
      if (endpoint.operation === 'items.get')
        return Promise.resolve({
          id: itemId,
          workspaceId: workspace,
          parentId: null,
          type: 'note',
        });
      throw new Error(`unexpected query ${endpoint.operation}`);
    });
    execute.mockImplementation(
      (endpoint: { operation: string; body?: { inputs?: Record<string, string> } }) => {
        if (endpoint.operation === 'templates.preflight')
          return Promise.resolve({ canApply: true, conflicts: [] });
        if (endpoint.operation === 'templates.apply')
          return Promise.resolve({
            targetItemId: itemId,
            createdItems: [],
            alreadyApplied: false,
            fileTransferPending: false,
          });
        throw new Error(`unexpected execute ${endpoint.operation}`);
      },
    );
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('apply_template', {
        itemId,
        parentId: itemId,
        title: 'Applied',
        specJson: '{"inputs":{"due":"2026-10-01"}}',
      }),
      signal,
      { toolId: 'tool', claimId: 'claim' },
    );
    expect(JSON.parse(outcome.text)).toMatchObject({ alreadyApplied: false });
    expect(
      execute.mock.calls.find(
        ([endpoint]) => (endpoint as { operation: string }).operation === 'templates.preflight',
      )?.[0],
    ).toMatchObject({ body: { inputs: { due: '2026-10-01' } } });
    expect(
      execute.mock.calls.find(
        ([endpoint]) => (endpoint as { operation: string }).operation === 'templates.apply',
      )?.[0],
    ).toMatchObject({ body: { inputs: { due: '2026-10-01' } } });
  });

  it('loads root-level create_structured context without looking up an empty parent id', async () => {
    const { ports, query, signal } = setup();
    const args = {
      operation: 'create_structured',
      itemId: '',
      parentId: '',
      title: 'Board',
      markdown: '',
      query: '',
      propertiesJson: '',
      specJson: '{"recipe":"board","fields":[]}',
    } as const;
    const context = await loadPreviewContext(ports, workspace, args, signal);
    expect(context.destination).toEqual({ title: 'Workspace root', path: [] });
    expect(context.inheritedFields).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('accepts apply_template with omitted specJson inputs during preflight', async () => {
    const { ports, query, execute, signal } = setup();
    query.mockImplementation((endpoint: { operation: string }) => {
      if (endpoint.operation === 'templates.list')
        return Promise.resolve({ templates: [{ id: itemId }], capabilities: { canManage: true } });
      throw new Error(`unexpected query ${endpoint.operation}`);
    });
    execute.mockResolvedValue({ canApply: true, conflicts: [] });
    const args = {
      operation: 'apply_template',
      itemId,
      parentId: '',
      title: 'Applied',
      markdown: '',
      query: '',
      propertiesJson: '',
      specJson: '',
    } as const;
    const context = await loadPreviewContext(ports, workspace, args, signal);
    expect(context.preflight).toMatchObject({ canApply: true });
    const preflightCall = execute.mock.calls.find(
      ([endpoint]) => (endpoint as { operation: string }).operation === 'templates.preflight',
    );
    expect(preflightCall?.[0]).toMatchObject({ operation: 'templates.preflight' });
    expect((preflightCall?.[0] as { body: object }).body).not.toHaveProperty('inputs');
  });

  it('sends create_structured through the named request with publishing disabled', async () => {
    const { ports, execute, signal } = setup();
    execute.mockImplementation((endpoint: { operation: string }) =>
      endpoint.operation === 'items.createStructured'
        ? Promise.resolve({ item: { id: itemId, title: 'Board' }, publicForm: null })
        : Promise.reject(new Error(`unexpected execute ${endpoint.operation}`)),
    );
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('create_structured', {
        title: 'Board',
        specJson: '{"recipe":"board","fields":[]}',
      }),
      signal,
      { fence: structureFingerprint({ declared: [] }, []) },
    );
    expect(JSON.parse(outcome.text)).toMatchObject({ id: itemId, created: true });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      operation: 'items.createStructured',
      body: { publishInteractiveFormViewId: null },
    });
    expect(outcome.touchedParents).toEqual([null]);
  });

  it.each(['create_structured', 'add_view', 'add_fields'] as const)(
    'refuses an invented property function in %s without a write',
    async (operation) => {
      const { ports, execute, signal } = setup();
      const fields = [
        { key: 'total', label: 'Total', type: 'formula', formula: 'PROPERTY("price")' },
      ];
      const spec =
        operation === 'create_structured'
          ? { recipe: 'list', fields }
          : operation === 'add_view'
            ? { fields, views: [{ kind: 'list' }] }
            : { fields };
      const args = input(operation, {
        itemId: operation === 'create_structured' ? '' : itemId,
        title: 'Totals',
        specJson: JSON.stringify(spec),
      });
      const preview = await loadPreviewContext(
        ports,
        workspace,
        workspaceToolSchema.parse(JSON.parse(args)),
        signal,
      );
      await expect(
        runWorkspaceTool(ports, workspace, args, signal, { fence: preview.fingerprint }),
      ).rejects.toThrow('PROPERTY is not a supported function');
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('refuses add_view when the approved fingerprint is stale', async () => {
    const { ports, execute, signal } = setup();
    await expect(
      runWorkspaceTool(
        ports,
        workspace,
        input('add_view', { itemId, specJson: '{"views":[{"kind":"list"}]}' }),
        signal,
        { fence: 'stale' },
      ),
    ).rejects.toThrow('changed since you approved');
    expect(execute).not.toHaveBeenCalled();
  });

  it('adds a view through appendViewSetup with publishing disabled', async () => {
    const { ports, execute, signal } = setup();
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('add_view', { itemId, specJson: '{"views":[{"kind":"list"}]}' }),
      signal,
      {
        fence: structureFingerprint(
          {
            declared: [],
            effective: [],
            inherit: true,
            defaultViewId: 'document',
            hideDocument: false,
          },
          [],
        ),
      },
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      operation: 'views.appendSetup',
      body: { makeDefault: false, publishInteractiveFormViewId: null },
    });
    expect(outcome.touchedParents).toEqual([itemId]);
  });

  it('dispatches add_fields through appendViewSetup with only new properties', async () => {
    const { ports, execute, signal } = setup();
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('add_fields', {
        itemId,
        specJson: '{"fields":[{"key":"status","label":"Status","type":"text"}]}',
      }),
      signal,
      {
        fence: structureFingerprint(
          {
            declared: [],
            effective: [],
            inherit: true,
            defaultViewId: 'document',
            hideDocument: false,
          },
          [],
        ),
      },
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      operation: 'views.appendSetup',
      body: {
        properties: [{ key: 'status', type: 'text' }],
        views: [],
        makeDefault: false,
        publishInteractiveFormViewId: null,
      },
    });
    expect(outcome.touchedParents).toEqual([itemId]);
  });

  it('keeps every existing property when adding generated fields', async () => {
    for (let count = 1; count <= 8; count++) {
      const { ports, execute, signal } = setup();
      const fields = Array.from({ length: count }, (_, index) => ({
        key: `added_${index.toString()}`,
        label: `Added ${index.toString()}`,
        type: 'text',
      }));
      await runWorkspaceTool(
        ports,
        workspace,
        input('add_fields', { itemId, specJson: JSON.stringify({ fields }) }),
        signal,
        {
          fence: structureFingerprint(
            {
              declared: [],
              effective: [],
              inherit: true,
              defaultViewId: 'document',
              hideDocument: false,
            },
            [],
          ),
        },
      );
      const endpoint = execute.mock.calls[0]?.[0] as
        | { operation: string; body?: { properties?: { key: string }[]; views?: unknown[] } }
        | undefined;
      expect(endpoint?.operation).toBe('views.appendSetup');
      expect(endpoint?.body?.properties?.map((property) => property.key)).toEqual(
        fields.map((field) => field.key),
      );
      expect(endpoint?.body?.views).toEqual([]);
    }
  });

  it('refuses edit_form when the approved fingerprint is stale', async () => {
    const { ports, execute, signal } = setup();
    await expect(
      runWorkspaceTool(
        ports,
        workspace,
        input('edit_form', {
          itemId,
          specJson: '{"viewId":"form","form":{"pages":[]}}',
        }),
        signal,
        { fence: 'stale' },
      ),
    ).rejects.toThrow('changed since you approved');
    expect(execute).not.toHaveBeenCalled();
  });

  it('dispatches set_recurrence after validating the current due date value', async () => {
    const { ports, query, execute, signal } = setup();
    query.mockImplementation((endpoint: { operation: string }) => {
      if (endpoint.operation === 'schema.get')
        return Promise.resolve({
          properties: [
            { key: 'due_date', label: 'Due date', type: 'due_date', options: [], required: false },
          ],
          declared: [
            { key: 'due_date', label: 'Due date', type: 'due_date', options: [], required: false },
          ],
          inherit: true,
        });
      if (endpoint.operation === 'views.getConfigurations')
        return Promise.resolve({ views: [], unrenderable: [], default: 'document' });
      if (endpoint.operation === 'items.get')
        return Promise.resolve({
          id: itemId,
          workspaceId: workspace,
          parentId: null,
          title: 'Plan',
          type: 'note',
          properties: { due_date: '2027-03-02' },
          computed: {},
        });
      throw new Error(`unexpected query ${endpoint.operation}`);
    });
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('set_recurrence', {
        itemId,
        specJson: '{"frequency":"weekly","interval":1,"weekdays":[1,3],"until":"2027-04-02"}',
      }),
      signal,
      {
        fence: (
          await loadPreviewContext(
            ports,
            workspace,
            workspaceToolSchema.parse(
              JSON.parse(input('set_recurrence', { itemId, specJson: '{}' })),
            ),
            signal,
          )
        ).fingerprint,
      },
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      operation: 'recurrence.set',
      body: { freq: 'weekly', interval: 1, weekdays: ['mo', 'we'], until: '2027-04-02' },
    });
    expect(outcome.touchedParents).toEqual([itemId]);
  });

  it('dispatches edit_form with the companion preserved and an empty property replacement set', async () => {
    const { ports, query, execute, signal } = setup();
    const formView = {
      id: 'form',
      name: 'Signup',
      kind: 'interactive_form',
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
      companionViewId: 'responses',
      companionPlacement: 'beside',
      interactiveForm: {
        pages: [],
        titleMode: 'generated',
        titleFieldBlockId: null,
        confirmationTitle: 'Thanks',
        confirmationMessage: '',
      },
    };
    const companion = {
      id: 'responses',
      name: 'Responses',
      kind: 'list',
      columns: ['status'],
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
      companionViewId: null,
      companionPlacement: null,
      interactiveForm: null,
    };
    query.mockImplementation((endpoint: { operation: string }) => {
      if (endpoint.operation === 'schema.get')
        return Promise.resolve({
          properties: [
            { key: 'status', label: 'Status', type: 'text', options: [], required: false },
          ],
          declared: [
            { key: 'status', label: 'Status', type: 'text', options: [], required: false },
          ],
          inherit: true,
        });
      if (endpoint.operation === 'views.getConfigurations')
        return Promise.resolve({ views: [formView, companion], unrenderable: [], default: 'form' });
      if (endpoint.operation === 'items.get')
        return Promise.resolve({
          id: itemId,
          workspaceId: workspace,
          parentId: null,
          title: 'Plan',
          type: 'note',
          properties: {},
          computed: {},
        });
      throw new Error(`unexpected query ${endpoint.operation}`);
    });
    await runWorkspaceTool(
      ports,
      workspace,
      input('edit_form', {
        itemId,
        specJson: JSON.stringify({
          viewId: 'form',
          form: { pages: [{ title: 'Details', blocks: [{ field: 'status' }] }] },
        }),
      }),
      signal,
      {
        fence: (
          await loadPreviewContext(
            ports,
            workspace,
            workspaceToolSchema.parse(JSON.parse(input('edit_form', { itemId, specJson: '{}' }))),
            signal,
          )
        ).fingerprint,
      },
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      operation: 'views.replaceSetup',
      path: '/api/v1/items/22222222-2222-4222-8222-222222222222/view-setups/form',
      body: {
        schema: { properties: [], inherit: true },
        originalPropertyKeys: [],
        views: [
          { id: 'form', kind: 'interactive_form', companionViewId: 'responses' },
          { id: 'responses', columns: ['status'], kind: 'list' },
        ],
        publishInteractiveFormViewId: null,
      },
    });
  });

  it('read_structure reports inherited and computed fields with a bounded child count', async () => {
    const { ports, query, paginate, signal } = setup();
    query.mockImplementation((endpoint: { operation: string }) => {
      if (endpoint.operation === 'items.get')
        return Promise.resolve({
          id: itemId,
          workspaceId: workspace,
          parentId: null,
          title: 'Board',
          type: 'note',
        });
      if (endpoint.operation === 'schema.get')
        return Promise.resolve({
          properties: [
            {
              key: 'status',
              label: 'Status',
              type: 'select',
              options: ['To read'],
              required: true,
            },
            { key: 'total', label: 'Total', type: 'formula', options: [], required: false },
          ],
          declared: [
            {
              key: 'status',
              label: 'Status',
              type: 'select',
              options: ['To read'],
              required: true,
            },
          ],
          inherit: true,
        });
      if (endpoint.operation === 'views.getConfigurations')
        return Promise.resolve({
          views: [{ id: 'view', name: 'List', kind: 'list', dateProperty: null }],
          unrenderable: [],
          default: 'view',
        });
      throw new Error(`unexpected query ${endpoint.operation}`);
    });
    paginate.mockImplementation(async function* () {
      await Promise.resolve();
      yield { id: itemId };
      yield { id: '33333333-3333-4333-8333-333333333333' };
    });
    const result = await readStructure(ports, workspace, itemId, signal);
    expect(result.fields).toMatchObject([
      { key: 'status', inherited: false, computed: false },
      { key: 'total', inherited: true, computed: true },
    ]);
    expect(result.childCount).toBe('many');
    expect(paginate).toHaveBeenCalledOnce();
  });

  it('validates every create_entries value before the first write', async () => {
    const { ports, query, execute, signal } = setup();
    query.mockImplementation((endpoint: { operation: string }) => {
      if (endpoint.operation === 'items.get')
        return Promise.resolve({
          id: itemId,
          workspaceId: workspace,
          parentId: null,
          title: 'Board',
          type: 'note',
        });
      if (endpoint.operation === 'schema.get')
        return Promise.resolve({
          properties: [
            { key: 'status', label: 'Status', type: 'select', options: ['Done'], required: false },
          ],
          declared: [
            { key: 'status', label: 'Status', type: 'select', options: ['Done'], required: false },
          ],
          inherit: true,
        });
      throw new Error(`unexpected query ${endpoint.operation}`);
    });
    await expect(
      runWorkspaceTool(
        ports,
        workspace,
        input('create_entries', {
          parentId: itemId,
          specJson:
            '{"entries":[{"title":"First","values":{"status":"Invalid"}},{"title":"Second","values":{"missing":true}}]}',
        }),
        signal,
        { fence: 'status:select|' },
      ),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it('stops create_entries after the first failed create and reports later rows untouched', async () => {
    const { ports, query, execute, signal } = setup();
    query.mockImplementation((endpoint: { operation: string }) =>
      Promise.resolve(
        endpoint.operation === 'schema.get'
          ? { properties: [], declared: [], inherit: true }
          : { id: itemId, workspaceId: workspace, parentId: null, title: 'Board', type: 'note' },
      ),
    );
    let writes = 0;
    execute.mockImplementation((endpoint: { operation: string }) => {
      if (endpoint.operation === 'items.create') {
        writes += 1;
        return writes === 1
          ? Promise.resolve({ id: '33333333-3333-4333-8333-333333333333' })
          : Promise.reject(new Error('write failed'));
      }
      return Promise.reject(new Error(`unexpected execute ${endpoint.operation}`));
    });
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('create_entries', {
        parentId: itemId,
        specJson: '{"entries":[{"title":"First"},{"title":"Second"},{"title":"Third"}]}',
      }),
      signal,
      { fence: structureFingerprint({ declared: [] }, []) },
    );
    expect(JSON.parse(outcome.text)).toMatchObject({
      created: [{ index: 0, id: '33333333-3333-4333-8333-333333333333' }],
      failed: { index: 1, reason: 'write failed' },
      notAttempted: [2],
    });
    expect(writes).toBe(2);
  });

  it('reports an unconfirmed entry body and never retries its create', async () => {
    const { ports, query, execute, bodies, signal } = setup();
    query.mockImplementation((endpoint: { operation: string }) =>
      Promise.resolve(
        endpoint.operation === 'schema.get'
          ? { properties: [], declared: [], inherit: true }
          : { id: itemId, workspaceId: workspace, parentId: null, title: 'Board', type: 'note' },
      ),
    );
    execute.mockResolvedValue({ id: '33333333-3333-4333-8333-333333333333' });
    bodies.append.mockRejectedValue(new Error('connection lost'));
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('create_entries', {
        parentId: itemId,
        specJson: '{"entries":[{"title":"First","markdown":"body"}]}',
      }),
      signal,
      { fence: structureFingerprint({ declared: [] }, []) },
    );
    expect(JSON.parse(outcome.text)).toMatchObject({
      created: [{ index: 0, id: '33333333-3333-4333-8333-333333333333' }],
      failed: { index: 0, reason: 'The entry was created but its body was not confirmed.' },
      contentConfirmed: false,
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  describe.each([
    ['replace_section', { query: 'Next steps', markdown: '- Book the venue' }],
    ['replace_passage', { query: 'teh plan', markdown: 'the plan' }],
  ] as const)('%s', (operation, fields) => {
    const plan = {
      before: 'old',
      after: 'new',
      blocksRemoved: 1,
      blocksAdded: 1,
      losses: [],
      markdownChanges: {},
      fingerprint: '["fence"]',
    };
    const edit =
      operation === 'replace_section'
        ? { kind: 'section', heading: fields.query, markdown: fields.markdown }
        : { kind: 'passage', find: fields.query, replace: fields.markdown };

    it('previews the edit from the note as it is now', async () => {
      const { ports, bodies, signal } = setup();
      bodies.planEdit.mockResolvedValue(plan);
      const parsed = workspaceToolSchema.parse(JSON.parse(input(operation, { itemId, ...fields })));
      const context = await loadPreviewContext(ports, workspace, parsed, signal);
      expect(bodies.planEdit).toHaveBeenCalledWith(itemId, edit, signal);
      expect(context).toMatchObject({
        fingerprint: plan.fingerprint,
        bodyEdit: plan,
        problems: [],
      });
    });

    it('turns a refusal to place the edit into a preview problem', async () => {
      const { ports, bodies, signal } = setup();
      bodies.planEdit.mockRejectedValue(
        new WorkspaceToolRefusal('Not found; try nix_read_note.', 'Not found.'),
      );
      const parsed = workspaceToolSchema.parse(JSON.parse(input(operation, { itemId, ...fields })));
      const context = await loadPreviewContext(ports, workspace, parsed, signal);
      expect(context.bodyEdit).toBeUndefined();
      expect(context.problems).toEqual([
        {
          path: operation === 'replace_section' ? 'heading' : 'find',
          code: 'body_edit_refused',
          message: 'Not found.',
          modelMessage: 'Not found; try nix_read_note.',
        },
      ]);
    });

    it('applies the edit against the approved preview and reports it as a write', async () => {
      const { ports, bodies, execute, signal } = setup();
      bodies.applyEdit.mockResolvedValue({
        id: itemId,
        replaced: true,
        blocksRemoved: 1,
        blocksAdded: 2,
        markdownChanges: {},
      });
      const outcome = await runWorkspaceTool(
        ports,
        workspace,
        input(operation, { itemId, ...fields }),
        signal,
        { fence: plan.fingerprint },
      );
      expect(bodies.applyEdit).toHaveBeenCalledWith(itemId, edit, plan.fingerprint, signal);
      expect(JSON.parse(outcome.text)).toMatchObject({ replaced: true, blocksAdded: 2 });
      expect(outcome).toMatchObject({ readOnly: false, touchedParents: [], lockedContent: false });
      expect(execute).not.toHaveBeenCalled();
    });

    it.each([true, false])(
      'marks a refusal that may quote the note as locked content only when the note is under a lock (%s)',
      async (locked) => {
        const { ports, query, bodies, signal } = setup();
        query.mockImplementation((endpoint: { operation: string }) =>
          Promise.resolve(
            endpoint.operation === 'locks.get'
              ? {
                  locked,
                  unlockedUntil: locked ? '2030-01-01T00:00:00+00:00' : null,
                  lockItemId: locked ? itemId : null,
                  selfLocked: locked,
                }
              : {
                  id: itemId,
                  workspaceId: workspace,
                  parentId: null,
                  title: 'Diary',
                  type: 'note',
                },
          ),
        );
        const refusal = () =>
          new WorkspaceToolRefusal(
            'No heading "X". Headings in this note: "Secret".',
            'Not found.',
          );
        bodies.applyEdit.mockRejectedValue(refusal());
        await expect(
          runWorkspaceTool(ports, workspace, input(operation, { itemId, ...fields }), signal, {
            fence: plan.fingerprint,
          }),
        ).rejects.toMatchObject({ lockedContent: locked });
        bodies.planEdit.mockRejectedValue(refusal());
        const parsed = workspaceToolSchema.parse(
          JSON.parse(input(operation, { itemId, ...fields })),
        );
        const context = await loadPreviewContext(ports, workspace, parsed, signal);
        expect(context.refusalQuotesLockedContent).toBe(locked);
      },
    );

    it('refuses without an approved preview', async () => {
      const { ports, bodies, signal } = setup();
      await expect(
        runWorkspaceTool(ports, workspace, input(operation, { itemId, ...fields }), signal),
      ).rejects.toThrow('no approved preview');
      expect(bodies.applyEdit).not.toHaveBeenCalled();
    });

    it('refuses an item that is not a note', async () => {
      const { ports, query, bodies, signal } = setup();
      query.mockResolvedValue({ id: itemId, workspaceId: workspace, parentId: null, type: 'page' });
      await expect(
        runWorkspaceTool(ports, workspace, input(operation, { itemId, ...fields }), signal, {
          fence: plan.fingerprint,
        }),
      ).rejects.toMatchObject({
        message: 'Only a note body can be edited. No change was made.',
        ownerMessage: 'Only a note’s text can be edited this way, so nothing was edited.',
      });
      expect(bodies.applyEdit).not.toHaveBeenCalled();
    });

    it('refuses a cross-workspace note before reading its body', async () => {
      const { ports, query, bodies, signal } = setup();
      query.mockResolvedValue({ workspaceId: 'another-workspace', type: 'note' });
      await expect(
        runWorkspaceTool(ports, workspace, input(operation, { itemId, ...fields }), signal, {
          fence: plan.fingerprint,
        }),
      ).rejects.toThrow('outside this workspace');
      const parsed = workspaceToolSchema.parse(JSON.parse(input(operation, { itemId, ...fields })));
      await expect(loadPreviewContext(ports, workspace, parsed, signal)).rejects.toThrow(
        'outside this workspace',
      );
      expect(bodies.planEdit).not.toHaveBeenCalled();
      expect(bodies.applyEdit).not.toHaveBeenCalled();
    });

    it('requires the text to find', () => {
      expect(
        workspaceToolSchema.safeParse(JSON.parse(input(operation, { itemId, markdown: 'x' })))
          .success,
      ).toBe(false);
    });
  });

  it('requires new Markdown for a section but lets a passage be deleted', () => {
    const parse = (operation: string) =>
      workspaceToolSchema.safeParse(JSON.parse(input(operation, { itemId, query: 'Notes' })))
        .success;
    expect(parse('replace_section')).toBe(false);
    expect(parse('replace_passage')).toBe(true);
  });
});

describe('reading values, the calendar, and completing tasks', () => {
  const containerId = '33333333-3333-4333-8333-333333333333';
  const field = (key: string, type: string) => ({
    key,
    label: key,
    type,
    options: [],
    required: false,
    expression: null,
    aggregate: null,
    source: null,
  });
  const taskSchema = {
    properties: [
      field('title', 'text'),
      field('due_date', 'due_date'),
      field('start_date', 'start_date'),
      field('completion', 'completion'),
      field('status', 'select'),
      field('notes', 'long_text'),
      field('summary', 'text'),
    ],
    declared: [],
    inherit: true,
  };
  const child = (id: string, properties: Record<string, unknown>) => ({
    id,
    workspaceId: workspace,
    parentId: containerId,
    type: 'note',
    title: `Task ${id.slice(0, 2)}`,
    hasChildren: false,
    properties,
  });
  function listSetup(children: unknown[]) {
    const fake = setup();
    fake.query.mockImplementation((endpoint: { operation: string }) =>
      Promise.resolve(
        endpoint.operation === 'schema.get'
          ? taskSchema
          : {
              id: containerId,
              workspaceId: workspace,
              parentId: null,
              title: 'Tasks',
              type: 'note',
            },
      ),
    );
    fake.paginate.mockImplementation(async function* () {
      await Promise.resolve();
      yield* children;
    });
    return fake;
  }

  it('lists children with trimmed values keyed by the container schema and task fields on top', async () => {
    const { ports, signal } = listSetup([
      child('44444444-4444-4444-8444-444444444444', {
        title: 'Pay rent',
        due_date: '2026-10-01',
        completion: true,
        status: 'Doing',
        notes: 'A long body that never travels in a list.',
        summary: 'x'.repeat(500),
        $due_set_by: 'someone',
        stale_key: 'from a removed field',
      }),
    ]);
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('list_items', { parentId: containerId }),
      signal,
    );
    const result = JSON.parse(outcome.text) as {
      items: {
        dueDate: unknown;
        startDate: unknown;
        completed: boolean;
        properties: Record<string, unknown>;
      }[];
      truncated: boolean;
      propertiesOmitted?: boolean;
    };
    const [row] = result.items;
    expect(row).toMatchObject({ dueDate: '2026-10-01', startDate: null, completed: true });
    expect(row?.properties).toEqual({ status: 'Doing', summary: `${'x'.repeat(199)}…` });
    expect(row?.properties.summary).toHaveLength(200);
    expect(result.propertiesOmitted).toBeUndefined();
    expect(outcome.readOnly).toBe(true);
  });

  it('drops properties, keeps task fields, and says so when the values would not fit', async () => {
    const children = Array.from({ length: 50 }, (_, index) =>
      child(`${String(index).padStart(8, '0')}-4444-4444-8444-444444444444`, {
        due_date: '2026-10-02',
        completion: false,
        summary: 'y'.repeat(400),
      }),
    );
    const { ports, signal } = listSetup(children);
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('list_items', { parentId: containerId }),
      signal,
    );
    const result = JSON.parse(outcome.text) as {
      items: { dueDate: unknown; completed: boolean; properties?: unknown }[];
      propertiesOmitted: boolean;
      hint: string;
    };
    expect(outcome.text.length).toBeLessThanOrEqual(16000);
    expect(result.propertiesOmitted).toBe(true);
    expect(result.hint).toContain('nix_read_item');
    expect(result.items).toHaveLength(50);
    expect(result.items[0]).toMatchObject({ dueDate: '2026-10-02', completed: false });
    expect(result.items.every((row) => row.properties === undefined)).toBe(true);
  });

  it('never carries rollup values, which Core folds from children into computed, not properties', async () => {
    const withRollup = {
      ...taskSchema,
      properties: [
        ...taskSchema.properties,
        field('done_count', 'rollup'),
        field('score', 'formula'),
      ],
    };
    const fake = listSetup([
      {
        ...child('44444444-4444-4444-8444-444444444444', { status: 'Doing' }),
        hasChildren: true,
        computed: { done_count: 3 },
      },
    ]);
    fake.query.mockImplementation((endpoint: { operation: string }) =>
      Promise.resolve(
        endpoint.operation === 'schema.get'
          ? withRollup
          : {
              id: containerId,
              workspaceId: workspace,
              parentId: null,
              title: 'Tasks',
              type: 'note',
            },
      ),
    );
    const outcome = await runWorkspaceTool(
      fake.ports,
      workspace,
      input('list_items', { parentId: containerId }),
      fake.signal,
    );
    expect(outcome.text).not.toContain('done_count');
    expect(outcome.text).not.toContain('score');
  });

  it('lists the workspace root without reading any schema', async () => {
    const { ports, query, signal } = listSetup([
      { ...child('55555555-5555-4555-8555-555555555555', { status: 'x' }), parentId: null },
    ]);
    const outcome = await runWorkspaceTool(ports, workspace, input('list_items'), signal);
    const result = JSON.parse(outcome.text) as { items: Record<string, unknown>[] };
    expect(result.items[0]).toEqual({
      id: '55555555-5555-4555-8555-555555555555',
      title: 'Task 55',
      type: 'note',
      hasChildren: false,
    });
    expect(query).not.toHaveBeenCalled();
  });

  const calendarResponse = (entries: unknown[], extra: Record<string, unknown> = {}) => ({
    workspaceId: workspace,
    from: '2026-09-21',
    to: '2026-09-27',
    entries,
    unplaceable: [],
    entryLimit: 2000,
    entriesTruncated: false,
    seriesTruncated: false,
    ...extra,
  });
  const entry = (overrides: Record<string, unknown>) => ({
    itemId,
    title: 'Pay rent',
    containerId,
    containerTitle: 'Tasks',
    dateProperty: 'due_date',
    value: '2026-09-25',
    kind: 'date',
    generated: false,
    completed: null,
    endProperty: null,
    endValue: null,
    ...overrides,
  });

  it('reads the workspace calendar for a bounded window as trimmed rows', async () => {
    const { ports, query, signal } = setup();
    query.mockResolvedValue(
      calendarResponse(
        [
          entry({}),
          entry({ value: '2026-09-26', generated: true, completed: false }),
          entry({
            value: '2026-09-27T09:00:00+01:00[Europe/London]',
            endValue: '2026-09-27T10:00:00+01:00[Europe/London]',
            kind: 'timestamp',
          }),
        ],
        {
          unplaceable: [
            {
              containerId,
              containerTitle: 'Tasks',
              reason: 'no_date_property',
              itemId: null,
              itemTitle: null,
            },
          ],
        },
      ),
    );
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('read_calendar', { specJson: '{"from":"2026-09-21","to":"2026-09-27"}' }),
      signal,
    );
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'workspaceCalendar.get',
        path: `/api/v1/workspaces/${workspace}/calendar?from=2026-09-21&to=2026-09-27`,
      }),
      expect.objectContaining({ forceRefresh: true }),
    );
    const result = JSON.parse(outcome.text) as { entries: Record<string, unknown>[] };
    expect(result).toMatchObject({ truncated: false, unplaceable: 1 });
    expect(result.entries).toEqual([
      { itemId, title: 'Pay rent', containerTitle: 'Tasks', value: '2026-09-25' },
      {
        itemId,
        title: 'Pay rent',
        containerTitle: 'Tasks',
        value: '2026-09-26',
        completed: false,
        generated: true,
      },
      {
        itemId,
        title: 'Pay rent',
        containerTitle: 'Tasks',
        value: '2026-09-27T09:00:00+01:00[Europe/London]',
        endValue: '2026-09-27T10:00:00+01:00[Europe/London]',
      },
    ]);
    expect(outcome.readOnly).toBe(true);
  });

  it('caps calendar rows and says the window holds more', async () => {
    const { ports, query, signal } = setup();
    query.mockResolvedValue(calendarResponse(Array.from({ length: 150 }, () => entry({}))));
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('read_calendar', { specJson: '{"from":"2026-09-21","to":"2026-09-27"}' }),
      signal,
    );
    const result = JSON.parse(outcome.text) as {
      entries: unknown[];
      truncated: boolean;
      hint: string;
    };
    expect(result.entries).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(result.hint).toContain('shorter range');
  });

  it.each([
    ['{"from":"2026-09-01","to":"2026-10-02"}', 'at most 31 days'],
    ['{"from":"2026-09-27","to":"2026-09-21"}', 'on or before'],
    ['{"from":"2026-02-30","to":"2026-03-02"}', 'yyyy-MM-dd'],
  ])('refuses the calendar range %s before reading anything', async (specJson, message) => {
    const { ports, query, signal } = setup();
    await expect(
      runWorkspaceTool(ports, workspace, input('read_calendar', { specJson }), signal),
    ).rejects.toThrow(message);
    expect(query).not.toHaveBeenCalled();
  });

  it('accepts a full 31-day calendar window', async () => {
    const { ports, query, signal } = setup();
    query.mockResolvedValue(calendarResponse([]));
    await runWorkspaceTool(
      ports,
      workspace,
      input('read_calendar', { specJson: '{"from":"2026-09-01","to":"2026-10-01"}' }),
      signal,
    );
    expect(query).toHaveBeenCalledOnce();
  });

  function taskSetup(options: {
    properties: Record<string, unknown>;
    schema?: { properties: unknown[]; declared: unknown[]; inherit: boolean };
    calendar?: unknown;
  }) {
    const fake = setup();
    fake.query.mockImplementation((endpoint: { operation: string }) =>
      Promise.resolve(
        endpoint.operation === 'schema.get'
          ? (options.schema ?? taskSchema)
          : endpoint.operation === 'workspaceCalendar.get'
            ? (options.calendar ?? calendarResponse([]))
            : {
                id: itemId,
                workspaceId: workspace,
                parentId: containerId,
                title: 'Pay rent',
                type: 'note',
                properties: options.properties,
              },
      ),
    );
    fake.execute.mockImplementation(
      (endpoint: { operation: string; body: { occurredOn?: string } }) =>
        Promise.resolve(
          endpoint.operation === 'recurrence.complete'
            ? { rule: null, occurredOn: endpoint.body.occurredOn }
            : { id: itemId },
        ),
    );
    return fake;
  }
  const completeArgs = (completed: boolean) =>
    input('complete_task', { itemId, specJson: JSON.stringify({ completed }) });

  it('completes a plain task through its completion field, fenced by its preview', async () => {
    const { ports, query, execute, signal } = taskSetup({ properties: { completion: false } });
    const context = await loadPreviewContext(
      ports,
      workspace,
      workspaceToolSchema.parse(JSON.parse(completeArgs(true))),
      signal,
    );
    expect(context.problems).toEqual([]);
    expect(context.taskCompletion).toMatchObject({ kind: 'property', key: 'completion' });
    const outcome = await runWorkspaceTool(ports, workspace, completeArgs(true), signal, {
      fence: context.fingerprint,
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'properties.set',
        body: { properties: { completion: true } },
      }),
      expect.anything(),
    );
    expect(JSON.parse(outcome.text)).toEqual({
      id: itemId,
      title: 'Pay rent',
      completed: true,
      recurring: false,
    });
    expect(outcome.readOnly).toBe(false);
    // No due date: there is no series to look for, so the calendar is never read.
    expect(query).not.toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'workspaceCalendar.get' }),
      expect.anything(),
    );
  });

  it('reopens a plain task and writes nothing when it already matches', async () => {
    const { ports, execute, signal } = taskSetup({ properties: { completion: true } });
    const fence = `task:property:${itemId}:completion:false`;
    await runWorkspaceTool(ports, workspace, completeArgs(false), signal, { fence });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ body: { properties: { completion: false } } }),
      expect.anything(),
    );

    const again = taskSetup({ properties: { completion: false } });
    const outcome = await runWorkspaceTool(
      again.ports,
      workspace,
      completeArgs(false),
      again.signal,
      { fence },
    );
    expect(again.execute).not.toHaveBeenCalled();
    expect(JSON.parse(outcome.text)).toMatchObject({ completed: false, unchanged: true });
  });

  it('completes the earliest open occurrence of a repeating task through recurrence completion', async () => {
    const { ports, execute, signal } = taskSetup({
      properties: { due_date: '2026-09-01', completion: false },
      calendar: calendarResponse([
        entry({ value: '2026-09-18', generated: true, completed: true }),
        entry({ value: '2026-09-25', generated: true, completed: false }),
        entry({ value: '2026-10-02', generated: true, completed: false }),
        entry({ itemId: containerId, value: '2026-09-20', generated: true, completed: false }),
      ]),
    });
    const context = await loadPreviewContext(
      ports,
      workspace,
      workspaceToolSchema.parse(JSON.parse(completeArgs(true))),
      signal,
    );
    expect(context.fingerprint).toBe(`task:occurrence:${itemId}:2026-09-25`);
    const outcome = await runWorkspaceTool(ports, workspace, completeArgs(true), signal, {
      fence: context.fingerprint,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'recurrence.complete',
        path: `/api/v1/items/${itemId}/recurrence/completions`,
        body: { occurredOn: '2026-09-25' },
      }),
      expect.anything(),
    );
    expect(JSON.parse(outcome.text)).toEqual({
      id: itemId,
      title: 'Pay rent',
      completed: true,
      recurring: true,
      occurredOn: '2026-09-25',
    });
  });

  it('refuses a future occurrence, naming its date, when nothing is open up to today', async () => {
    const { ports, execute, signal } = taskSetup({
      properties: { due_date: '2026-09-01' },
      calendar: calendarResponse([
        entry({ value: '2026-09-18', generated: true, completed: true }),
        entry({ value: '2026-10-02', generated: true, completed: false }),
      ]),
    });
    await expect(
      runWorkspaceTool(ports, workspace, completeArgs(true), signal, {
        fence: `task:occurrence:${itemId}:2026-10-02`,
      }),
    ).rejects.toThrow('next occurrence is on 2026-10-02');
    expect(execute).not.toHaveBeenCalled();
  });

  it('looks a year back for occurrences so a yearly task is still recognised', async () => {
    const { ports, query, signal } = taskSetup({
      properties: { due_date: '2025-10-01' },
      calendar: calendarResponse([
        entry({ value: '2025-10-01', generated: true, completed: false }),
      ]),
    });
    const context = await loadPreviewContext(
      ports,
      workspace,
      workspaceToolSchema.parse(JSON.parse(completeArgs(true))),
      signal,
    );
    expect(context.fingerprint).toBe(`task:occurrence:${itemId}:2025-10-01`);
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        path: `/api/v1/workspaces/${workspace}/calendar?from=2025-09-24&to=2026-10-26`,
      }),
      expect.anything(),
    );
  });

  it('refuses rather than set the series flag when the calendar read was cut short', async () => {
    const { ports, execute, signal } = taskSetup({
      properties: { due_date: '2026-09-01' },
      calendar: calendarResponse([], { seriesTruncated: true }),
    });
    await expect(
      runWorkspaceTool(ports, workspace, completeArgs(true), signal, {
        fence: `task:property:${itemId}:completion:true`,
      }),
    ).rejects.toThrow('could not confirm whether');
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a task under a lock that is closed to this credential', async () => {
    const fake = taskSetup({ properties: { completion: false } });
    const base = fake.query.getMockImplementation() as (endpoint: { operation: string }) => unknown;
    fake.query.mockImplementation((endpoint: { operation: string }) =>
      endpoint.operation === 'locks.get'
        ? Promise.resolve({
            locked: true,
            unlockedUntil: null,
            lockItemId: itemId,
            selfLocked: true,
          })
        : base(endpoint),
    );
    await expect(
      runWorkspaceTool(fake.ports, workspace, completeArgs(true), fake.signal, {
        fence: `task:property:${itemId}:completion:true`,
      }),
    ).rejects.toThrow('lock that is closed');
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it('refuses to reopen an occurrence of a repeating task', async () => {
    const { ports, execute, signal } = taskSetup({
      properties: { due_date: '2026-09-01' },
      calendar: calendarResponse([entry({ generated: true, completed: true })]),
    });
    await expect(
      runWorkspaceTool(ports, workspace, completeArgs(false), signal, { fence: 'x' }),
    ).rejects.toThrow('reopening one of its occurrences');
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a repeating task whose series cannot be drawn', async () => {
    const { ports, execute, signal } = taskSetup({
      properties: { due_date: '2026-09-01' },
      calendar: calendarResponse([], {
        unplaceable: [
          {
            containerId,
            containerTitle: 'Tasks',
            reason: 'calendar_not_by_due_date',
            itemId,
            itemTitle: 'Pay rent',
          },
        ],
      }),
    });
    await expect(
      runWorkspaceTool(ports, workspace, completeArgs(true), signal, { fence: 'x' }),
    ).rejects.toThrow('not placed by due date');
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses an item with no completion field and names nix_add_fields, on the card too', async () => {
    const schema = { properties: [field('status', 'select')], declared: [], inherit: true };
    const { ports, execute, signal } = taskSetup({ properties: {}, schema });
    await expect(
      runWorkspaceTool(ports, workspace, completeArgs(true), signal, { fence: 'x' }),
    ).rejects.toThrow('nix_add_fields');
    expect(execute).not.toHaveBeenCalled();
    const context = await loadPreviewContext(
      ports,
      workspace,
      workspaceToolSchema.parse(JSON.parse(completeArgs(true))),
      signal,
    );
    expect(context.problems[0]?.message).toContain('nix_add_fields');
    expect(context.taskCompletion).toBeUndefined();
  });

  it('refuses a completion whose approved plan no longer matches', async () => {
    const { ports, execute, signal } = taskSetup({ properties: { completion: false } });
    await expect(
      runWorkspaceTool(ports, workspace, completeArgs(true), signal, {
        fence: `task:occurrence:${itemId}:2026-09-25`,
      }),
    ).rejects.toThrow('changed since you approved');
    await expect(runWorkspaceTool(ports, workspace, completeArgs(true), signal)).rejects.toThrow(
      'changed since you approved',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    [true, true],
    [false, false],
  ])(
    'reports a read of a note under a lock (locked: %s) as locked content: %s',
    async (locked, expected) => {
      const fake = setup();
      fake.query.mockImplementation((endpoint: { operation: string }) =>
        Promise.resolve(
          endpoint.operation === 'locks.get'
            ? {
                locked,
                unlockedUntil: locked ? '2026-09-25T10:00:00+00:00' : null,
                lockItemId: locked ? containerId : null,
                selfLocked: false,
              }
            : {
                id: itemId,
                workspaceId: workspace,
                parentId: containerId,
                title: 'Plan',
                type: 'note',
              },
        ),
      );
      fake.bodies.read.mockResolvedValue({ markdown: 'secret' });
      const outcome = await runWorkspaceTool(
        fake.ports,
        workspace,
        input('read_note', { itemId }),
        fake.signal,
      );
      expect(outcome.lockedContent).toBe(expected);
      expect(fake.query).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'locks.get', path: `/api/v1/items/${itemId}/lock` }),
        expect.objectContaining({ forceRefresh: true }),
      );
    },
  );

  it('treats an unreadable lock state as locked, and never flags a write', async () => {
    const fake = setup();
    fake.query.mockImplementation((endpoint: { operation: string }) =>
      endpoint.operation === 'locks.get'
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({
            id: itemId,
            workspaceId: workspace,
            parentId: null,
            title: 'Plan',
            type: 'note',
          }),
    );
    const read = await runWorkspaceTool(
      fake.ports,
      workspace,
      input('read_item', { itemId }),
      fake.signal,
    );
    expect(read.lockedContent).toBe(true);
    const write = await runWorkspaceTool(
      fake.ports,
      workspace,
      input('rename_item', { itemId, title: 'New' }),
      fake.signal,
    );
    expect(write.lockedContent).toBe(false);
  });

  it('checks the containers a calendar read returned rows from', async () => {
    const { ports, query, signal } = setup();
    query.mockImplementation((endpoint: { operation: string }) =>
      Promise.resolve(
        endpoint.operation === 'locks.get'
          ? {
              locked: true,
              unlockedUntil: '2026-09-25T10:00:00+00:00',
              lockItemId: containerId,
              selfLocked: true,
            }
          : calendarResponse([entry({})]),
      ),
    );
    const outcome = await runWorkspaceTool(
      ports,
      workspace,
      input('read_calendar', { specJson: '{"from":"2026-09-21","to":"2026-09-27"}' }),
      signal,
    );
    expect(outcome.lockedContent).toBe(true);
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ path: `/api/v1/items/${containerId}/lock` }),
      expect.anything(),
    );
  });

  it('rejects complete_task without a boolean completed flag at the argument boundary', () => {
    expect(
      workspaceToolSchema.safeParse(
        JSON.parse(input('complete_task', { itemId, specJson: '{"completed":"yes"}' })),
      ).success,
    ).toBe(false);
    expect(
      workspaceToolSchema.safeParse(
        JSON.parse(input('read_calendar', { specJson: '{"from":"2026-09-01"}' })),
      ).success,
    ).toBe(false);
  });
});

it('edits a field only with a current approved preview and keeps unrelated fields', async () => {
  const { ports, query, execute, signal } = setup();
  const who = { key: 'who', label: 'Who', type: 'text', options: [], required: false };
  const reason = { key: 'reason', label: 'Reason', type: 'text', options: [], required: true };
  query.mockImplementation((endpoint: { operation: string }) =>
    Promise.resolve(
      endpoint.operation === 'schema.get'
        ? { properties: [who, reason], declared: [who, reason], inherit: false }
        : endpoint.operation === 'views.getConfigurations'
          ? { views: [], unrenderable: [], default: 'document', hideDocument: false }
          : { id: itemId, workspaceId: workspace, parentId: null, title: 'Grudges', type: 'note' },
    ),
  );
  const args = workspaceToolSchema.parse(
    JSON.parse(
      input('edit_fields', {
        itemId,
        specJson: JSON.stringify({
          fields: [{ key: 'who', label: 'Who', type: 'select', choiceSource: {} }],
        }),
      }),
    ),
  );
  const preview = await loadPreviewContext(ports, workspace, args, signal);
  await expect(
    runWorkspaceTool(ports, workspace, JSON.stringify(args), signal, { fence: 'old' }),
  ).rejects.toThrow('changed since you approved');
  expect(execute).not.toHaveBeenCalled();
  const result = await runWorkspaceTool(ports, workspace, JSON.stringify(args), signal, {
    fence: preview.fingerprint,
  });
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]?.[0]).toMatchObject({
    operation: 'schema.set',
    body: {
      inherit: false,
      properties: [
        { ...who, type: 'select', choiceSource: { itemId: null, field: 'who' } },
        reason,
      ],
    },
  });
  expect(result.touchedParents).toEqual([itemId]);
});
