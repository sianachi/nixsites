import { describe, expect, it } from 'vitest';
import { viewConfigurationSchema } from '@nix/api-client';
import { createFakePorts } from '../testing/fake-ports.js';
import { loadPreviewContext } from '../context.js';
import { runWorkspaceTool } from '../run.js';
import { describeToolCall } from '../preview.js';
import { workspaceToolSchema } from '../tool-args.js';

const workspace = '11111111-1111-4111-8111-111111111111';
const itemId = '22222222-2222-4222-8222-222222222222';
const field = {
  key: 'status',
  label: 'Status',
  type: 'select',
  options: ['Open', 'Done'],
  required: false,
};
const sort = { property: 'status', descending: false };
function setup(version: string | null = 'a'.repeat(64)) {
  const fake = createFakePorts();
  const state = {
    fields: [field],
    inherit: true,
    default: 'list',
    views: [
      viewConfigurationSchema.parse({
        id: 'list',
        name: 'Tasks',
        kind: 'list',
        open: 'beside',
        columns: ['status'],
        groupBy: 'status',
        sortBy: 'status',
        sorts: [sort],
        collapsedGroups: ['Done'],
        groupLimits: [{ group: 'Open', limit: '7' }],
        aggregates: [{ property: 'status', function: 'count' }],
        filters: [{ any: [{ property: 'status', operator: 'equals', value: 'Open' }] }],
      }),
    ],
  };
  fake.query.mockImplementation((endpoint: { operation: string }) =>
    Promise.resolve(
      endpoint.operation === 'items.getWorkspacePetProtection'
        ? { hasProtectedItems: false }
        : endpoint.operation === 'schema.get'
          ? { declared: state.fields, properties: state.fields, inherit: state.inherit }
          : endpoint.operation === 'views.getConfigurations'
            ? {
                views: state.views,
                default: state.default,
                unrenderable: [],
                hideDocument: false,
                version,
              }
            : { id: itemId, workspaceId: workspace, parentId: null, title: 'Tasks', type: 'note' },
    ),
  );
  fake.execute.mockResolvedValue({ updated: true });
  return { ...fake, state };
}
function args(patch: object = { name: 'Team tasks' }) {
  return workspaceToolSchema.parse({
    operation: 'update_view',
    itemId,
    parentId: '',
    title: '',
    markdown: '',
    query: '',
    propertiesJson: '',
    specJson: JSON.stringify({ viewId: 'list', patch }),
  });
}

describe('existing view refinements', () => {
  it('previews the actual before and after and writes no fields or unrelated settings', async () => {
    const { ports, signal, execute, state } = setup();
    const request = args();
    const preview = await loadPreviewContext(ports, workspace, request, signal);
    const model = describeToolCall(request, preview);
    expect(model.problems).toEqual([]);
    expect(JSON.stringify(model)).toContain('Tasks');
    expect(JSON.stringify(model)).toContain('Team tasks');
    const outcome = await runWorkspaceTool(ports, workspace, JSON.stringify(request), signal, {
      fence: preview.fingerprint,
    });
    expect(outcome.readOnly).toBe(false);
    expect(outcome.touchedParents).toEqual([itemId]);
    const endpoint = execute.mock.calls[0]?.[0] as {
      body: { views: object[]; default: string; hideDocument: boolean };
    };
    expect(execute).toHaveBeenCalledOnce();
    expect(endpoint).toMatchObject({
      operation: 'views.set',
      body: { default: 'list', hideDocument: false, expectedVersion: 'a'.repeat(64) },
    });
    expect(endpoint.body.views[0]).toMatchObject({
      ...state.views[0],
      name: 'Team tasks',
      groupLimits: [{ group: 'Open', limit: 7 }],
    });
  });

  it.each(['name', 'filters', 'field options', 'inherit', 'default'])(
    'refuses when %s changes after approval',
    async (setting) => {
      const { ports, signal, execute, state } = setup();
      const request = args();
      const preview = await loadPreviewContext(ports, workspace, request, signal);
      const target = state.views[0];
      if (target === undefined) throw new Error('Test target is missing.');
      if (setting === 'name') target.name = 'Changed elsewhere';
      if (setting === 'filters') target.filters = [];
      if (setting === 'field options') state.fields = [{ ...field, options: ['Other'] }];
      if (setting === 'inherit') state.inherit = false;
      if (setting === 'default') state.default = 'document';
      await expect(
        runWorkspaceTool(ports, workspace, JSON.stringify(request), signal, {
          fence: preview.fingerprint,
        }),
      ).rejects.toThrow('changed since you approved');
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('refuses missing approval and forbidden patches before mutation', async () => {
    const { ports, signal, execute } = setup();
    await expect(
      runWorkspaceTool(ports, workspace, JSON.stringify(args()), signal),
    ).rejects.toThrow('changed since you approved');
    const request = args({ kind: 'board' });
    const preview = await loadPreviewContext(ports, workspace, request, signal);
    expect(describeToolCall(request, preview).problems.length).toBeGreaterThan(0);
    await expect(
      runWorkspaceTool(ports, workspace, JSON.stringify(request), signal, {
        fence: preview.fingerprint,
      }),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails closed when Core cannot provide a conditional write version', async () => {
    const { ports, signal, execute } = setup(null);
    const request = args();
    const preview = await loadPreviewContext(ports, workspace, request, signal);
    expect(describeToolCall(request, preview).problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'version_required' })]),
    );
    await expect(
      runWorkspaceTool(ports, workspace, JSON.stringify(request), signal, {
        fence: preview.fingerprint,
      }),
    ).rejects.toThrow('concurrent changes');
    expect(execute).not.toHaveBeenCalled();
  });

  it('routes a view result as a read and holds later writes when aggregate contributors are unbounded', async () => {
    const { ports, signal, execute } = setup();
    execute.mockImplementation((endpoint: { operation: string }) =>
      Promise.resolve(
        endpoint.operation === 'workspaceQuery.run'
          ? {
              results: [
                {
                  id: itemId,
                  title: 'Example',
                  containerId: itemId,
                  workspaceId: workspace,
                  type: 'note',
                  properties: {},
                },
              ],
              groups: [],
              truncated: false,
            }
          : { count: 1, value: null, groups: [] },
      ),
    );
    const request = {
      ...args(),
      operation: 'read_view',
      specJson: '',
      query: JSON.stringify({ viewId: 'list', pageSize: 1 }),
    };
    const outcome = await runWorkspaceTool(ports, workspace, JSON.stringify(request), signal);
    expect(outcome.readOnly).toBe(true);
    expect(outcome.lockedContent).toBe(true);
    expect(JSON.parse(outcome.text)).toMatchObject({
      source: 'workspace_query',
      returned: 1,
      totalCount: 1,
      hasUnboundedProvenance: true,
    });
    expect(outcome.touchedParents).toEqual([]);
  });

  it('refuses a foreign item before reading or writing configuration', async () => {
    const { ports, signal, query, execute } = setup();
    query.mockResolvedValue({ id: itemId, workspaceId: 'another-workspace' });
    await expect(loadPreviewContext(ports, workspace, args(), signal)).rejects.toThrow(
      'outside this workspace',
    );
    expect(query).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });
});
