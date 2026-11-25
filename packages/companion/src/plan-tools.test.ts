import { describe, expect, it, vi } from 'vitest';
import {
  prepareWorkspacePlanTool,
  runPreparedWorkspacePlanTool,
  runWorkspacePlanDiscovery,
} from './plan-tools.js';
import { createFakePorts } from './testing/fake-ports.js';

const workspace = '11111111-1111-4111-8111-111111111111';
const target = '22222222-2222-4222-8222-222222222222';
const execution = {
  runId: workspace,
  planId: workspace,
  planVersion: 1,
  reviewDigest: 'review',
  stepId: target,
  claimId: workspace,
  executionId: target,
  dispatchContext: 'exact-context',
};
const args = JSON.stringify({
  operation: 'rename_item',
  itemId: target,
  parentId: '',
  title: 'Release brief',
  markdown: '',
  query: '',
  propertiesJson: '',
  specJson: '',
});
function setup() {
  const fake = createFakePorts();
  let title = 'Project brief';
  fake.query.mockImplementation((endpoint: { operation: string }) =>
    Promise.resolve(
      endpoint.operation.includes('Lock') || endpoint.operation.includes('locks')
        ? { locked: false }
        : {
            id: target,
            workspaceId: workspace,
            parentId: null,
            title,
            type: 'note',
            seq: 7,
            properties: {},
            settings: { withholdFromPets: false },
            updatedAt: '2026-11-24T10:00:00Z',
          },
    ),
  );
  fake.execute.mockResolvedValue({ id: target, title: 'Release brief' });
  return {
    ...fake,
    change: () => {
      title = 'Another edit';
    },
  };
}

describe('trusted workspace plan preparation', () => {
  it('saves serializable values and preview without dispatching an effect', async () => {
    const fake = setup();
    const prepared = await prepareWorkspacePlanTool({
      ports: fake.ports,
      workspaceId: workspace,
      arguments: args,
      signal: fake.signal,
      lockedRead: false,
    });
    expect(prepared.operation).toBe('rename_item');
    expect(prepared.preview.headline).toContain('Release brief');
    expect(prepared.fields).toEqual([
      { id: 'title', label: 'Title', kind: 'text', value: 'Release brief', required: true },
    ]);
    expect(JSON.parse(JSON.stringify(prepared))).toEqual(prepared);
    expect(fake.execute).not.toHaveBeenCalled();
    expect(fake.bodies.append).not.toHaveBeenCalled();
    expect(fake.bodies.applyEdit).not.toHaveBeenCalled();
  });

  it('rejects a changed target before creating execution ports or writing', async () => {
    const fake = setup();
    const prepared = await prepareWorkspacePlanTool({
      ports: fake.ports,
      workspaceId: workspace,
      arguments: args,
      signal: fake.signal,
      lockedRead: false,
    });
    fake.change();
    const dispatch = vi.fn().mockResolvedValue(fake.ports);
    await expect(
      runPreparedWorkspacePlanTool({
        ports: fake.ports,
        workspaceId: workspace,
        prepared,
        signal: fake.signal,
        executionContext: execution,
        dispatch,
      }),
    ).rejects.toThrow('changed after this plan');
    expect(dispatch).not.toHaveBeenCalled();
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it('executes frozen values only through the supplied exact dispatch ports and returns the observed receipt', async () => {
    const fake = setup();
    const prepared = await prepareWorkspacePlanTool({
      ports: fake.ports,
      workspaceId: workspace,
      arguments: args,
      signal: fake.signal,
      lockedRead: false,
    });
    const dispatch = vi.fn().mockResolvedValue(fake.ports);
    const result = await runPreparedWorkspacePlanTool({
      ports: fake.ports,
      workspaceId: workspace,
      prepared,
      signal: fake.signal,
      executionContext: execution,
      dispatch,
    });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(execution, prepared);
    expect(fake.execute).toHaveBeenCalledOnce();
    expect(fake.execute.mock.calls[0]?.[0]).toMatchObject({
      operation: 'items.rename',
      body: { title: 'Release brief' },
    });
    expect(result.text).toContain('Release brief');
  });

  it('retains the protected-read memory refusal', async () => {
    const fake = setup();
    const memory = JSON.stringify({
      operation: 'remember',
      itemId: '',
      parentId: '',
      title: '',
      markdown: 'A protected fact',
      query: '',
      propertiesJson: '',
      specJson: '',
    });
    await expect(
      prepareWorkspacePlanTool({
        ports: fake.ports,
        workspaceId: workspace,
        arguments: memory,
        signal: fake.signal,
        lockedRead: true,
      }),
    ).rejects.toThrow('Protected content');
    expect(fake.query).not.toHaveBeenCalled();
    expect(fake.execute).not.toHaveBeenCalled();
  });
});

it('prepares a recoverable trash target through the existing trash query', async () => {
  const fake = setup();
  fake.paginate.mockImplementation(async function* () {
    await Promise.resolve();
    yield {
      id: target,
      workspaceId: workspace,
      parentId: null,
      title: 'Deleted brief',
      type: 'note',
      seq: 8,
      properties: {},
      settings: { withholdFromPets: false },
    };
  });
  const input = JSON.stringify({
    operation: 'restore_item',
    itemId: target,
    parentId: '',
    title: '',
    markdown: '',
    query: '',
    propertiesJson: '',
    specJson: '',
  });
  const prepared = await prepareWorkspacePlanTool({
    ports: fake.ports,
    workspaceId: workspace,
    arguments: input,
    signal: fake.signal,
    lockedRead: false,
  });
  expect(prepared.targetIds).toEqual([target]);
  expect(fake.paginate).toHaveBeenCalledWith(
    expect.objectContaining({ operation: 'items.trash' }),
    expect.anything(),
  );
  expect(fake.execute).not.toHaveBeenCalled();
});

it('keeps template membership separate from item identity and permits only the readonly preflight POST', async () => {
  const fake = setup();
  fake.query.mockImplementation((endpoint: { operation: string }) => {
    if (endpoint.operation === 'templates.list')
      return Promise.resolve({ templates: [{ id: target }] });
    throw new Error('A template ID must not be loaded as an item.');
  });
  fake.execute.mockResolvedValue({
    canApply: true,
    additions: { items: 1, fields: 0, views: 0 },
    conflicts: [],
  });
  const input = JSON.stringify({
    operation: 'apply_template',
    itemId: target,
    parentId: '',
    title: 'New brief',
    markdown: '',
    query: '',
    propertiesJson: '',
    specJson: '',
  });
  const prepared = await prepareWorkspacePlanTool({
    ports: fake.ports,
    workspaceId: workspace,
    arguments: input,
    signal: fake.signal,
    lockedRead: false,
  });
  expect(prepared.targetIds).toEqual([]);
  expect(fake.execute).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ operation: 'templates.preflight' }),
    expect.anything(),
  );
});

it('performs trusted discovery with query-only ports and carries exact read sources', async () => {
  const fake = setup();
  const input = JSON.stringify({
    operation: 'read_item',
    itemId: target,
    parentId: '',
    title: '',
    markdown: '',
    query: '',
    propertiesJson: '',
    specJson: '',
  });
  const prepared = await prepareWorkspacePlanTool({
    ports: fake.ports,
    workspaceId: workspace,
    arguments: input,
    signal: fake.signal,
    lockedRead: false,
  });
  const outcome = await runWorkspacePlanDiscovery({
    ports: fake.ports,
    workspaceId: workspace,
    prepared,
    signal: fake.signal,
  });
  expect(outcome.readOnly).toBe(true);
  expect(outcome.sourceItemIds).toEqual([target]);
  expect(outcome.text).toContain('Project brief');
  expect(fake.execute).not.toHaveBeenCalled();
});

it('refuses a prepared mutation through the no-effect discovery path', async () => {
  const fake = setup();
  const prepared = await prepareWorkspacePlanTool({
    ports: fake.ports,
    workspaceId: workspace,
    arguments: args,
    signal: fake.signal,
    lockedRead: false,
  });
  await expect(
    runWorkspacePlanDiscovery({
      ports: fake.ports,
      workspaceId: workspace,
      prepared,
      signal: fake.signal,
    }),
  ).rejects.toThrow('prepared read');
  expect(fake.execute).not.toHaveBeenCalled();
});
