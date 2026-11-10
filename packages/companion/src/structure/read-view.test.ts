import { describe, expect, it } from 'vitest';
import { createFakePorts } from '../testing/fake-ports.js';
import { readView } from './read-view.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const itemId = '22222222-2222-4222-8222-222222222222';
const rowId = '33333333-3333-4333-8333-333333333333';
const row = {
  id: rowId,
  workspaceId,
  containerId: itemId,
  containerTitle: 'Tasks',
  title: 'Prepare',
  type: 'note',
  properties: { status: 'Ready', due: '2026-09-25' },
};
const view = {
  id: 'work',
  name: 'Work',
  kind: 'list',
  filters: [{ property: 'status', operator: 'equals', value: 'Ready' }],
  groupBy: 'status',
  groupOrder: ['Ready', 'Done'],
  sorts: [{ property: 'due', descending: false }],
  aggregates: [{ property: 'hours', function: 'sum' }],
};

function setup(overrides: Record<string, unknown> = {}) {
  const fake = createFakePorts();
  fake.query.mockImplementation((endpoint: { operation: string }) => {
    if (endpoint.operation === 'items.get')
      return Promise.resolve({ id: itemId, workspaceId, title: 'Tasks', type: 'note' });
    if (endpoint.operation === 'views.getConfigurations')
      return Promise.resolve({
        views: [{ ...view, ...overrides }],
        unrenderable: [],
        default: 'work',
        hideDocument: false,
      });
    if (endpoint.operation === 'schema.get')
      return Promise.resolve({
        properties: [{ key: 'status', label: 'Status', type: 'select' }],
        declared: [],
        inherit: true,
      });
    if (endpoint.operation === 'itemQuery.get')
      return Promise.resolve({
        itemId,
        viewId: 'work',
        today: '2026-09-25',
        results: [row],
        limit: 500,
        truncated: false,
      });
    if (endpoint.operation === 'chart.run')
      return Promise.resolve({
        itemId,
        viewId: 'work',
        groupBy: 'due',
        measure: 'count',
        measureProperty: null,
        buckets: Array.from({ length: 40 }, (_, i) => ({
          value: String(i),
          children: 2,
          total: null,
          cells: [],
        })),
        children: 80,
        distinctValues: 40,
        truncated: false,
        chartKind: 'line',
        period: 'day',
        splitBy: null,
        series: [],
        otherSeries: 0,
        from: null,
        to: null,
        outsideWindow: 0,
        unplaced: 3,
        stacked: false,
        cumulative: false,
        rollingAverage: false,
      });
    throw new Error(`Unexpected query ${endpoint.operation}`);
  });
  fake.execute.mockImplementation(
    (endpoint: { operation: string; body: { aggregate?: { function: string } } }) =>
      Promise.resolve(
        endpoint.operation === 'workspaceQuery.run'
          ? {
              workspaceId,
              today: '2026-09-25',
              results: [{ ...row, group: 'Ready' }],
              limit: 25,
              truncated: true,
              groupBy: 'status',
              groups: [{ key: 'Ready', label: 'Ready', count: 42 }],
            }
          : {
              workspaceId,
              today: '2026-09-25',
              function: endpoint.body.aggregate?.function,
              property: 'hours',
              groupBy: 'status',
              groups: [],
              total: 120,
              count: 42,
              skipped: endpoint.body.aggregate?.function === 'sum' ? 3 : 0,
              groupCount: 1,
              truncated: false,
            },
      ),
  );
  return fake;
}

describe('pet view result evidence', () => {
  it('asks Core to filter direct children before spending the sample limit and preserves exact count/skipped values', async () => {
    const fake = setup();
    const result = await readView(
      fake.ports,
      workspaceId,
      itemId,
      '{"viewId":"work","pageSize":5}',
      fake.signal,
    );
    expect(fake.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'workspaceQuery.run',
        method: 'POST',
        invalidates: [],
        body: expect.objectContaining({
          scope: { parentId: itemId, descendants: false },
          filters: view.filters.map((filter) => ({ ...filter, any: null })),
          groupBy: { property: 'status', order: ['Ready', 'Done'] },
          sort: { property: 'due', descending: false },
          limit: 5,
          today: '2026-09-25',
        }) as unknown,
      }),
      { signal: fake.signal },
    );
    expect(result).toMatchObject({
      source: 'workspace_query',
      appliedViewRules: true,
      totalCount: 42,
      returned: 1,
      truncated: true,
      nextCursor: null,
      hasUnboundedProvenance: true,
    });
    expect(result.results[0]).toMatchObject({ id: rowId, properties: row.properties });
    expect(result.aggregates?.[0]).toMatchObject({ function: 'sum', skipped: 3, count: 42 });
    expect(fake.paginate).not.toHaveBeenCalled();
  });

  it('runs a saved query on the reader day, scopes model rows, and never exposes a global count', async () => {
    const fake = setup({ kind: 'query' });
    const original = fake.query.getMockImplementation() as
      ((endpoint: { operation: string }) => Promise<unknown>) | undefined;
    fake.query.mockImplementation((endpoint: { operation: string }) =>
      endpoint.operation === 'itemQuery.get'
        ? Promise.resolve({
            itemId,
            viewId: 'work',
            today: '2026-09-25',
            results: [
              row,
              { ...row, id: 'foreign', workspaceId: 'outside', title: 'Private elsewhere' },
            ],
            limit: 500,
            truncated: false,
          })
        : original?.(endpoint),
    );
    const result = await readView(
      fake.ports,
      workspaceId,
      itemId,
      '{"viewId":"work"}',
      fake.signal,
    );
    expect(fake.query).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'itemQuery.get',
        path: expect.stringContaining('today=2026-09-25') as unknown,
      }),
      { signal: fake.signal, forceRefresh: true },
    );
    expect(result).toMatchObject({
      source: 'saved_query',
      totalCount: null,
      returned: 1,
      truncated: false,
    });
    expect(result.results).toEqual([row]);
    expect(JSON.stringify(result)).not.toContain('Private elsewhere');
    expect(result.groups).toBeUndefined();
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it('bounds chart buckets while preserving Core source totals and unplaced counts', async () => {
    const fake = setup({ kind: 'chart' });
    const result = await readView(
      fake.ports,
      workspaceId,
      itemId,
      '{"viewId":"work","pageSize":10}',
      fake.signal,
    );
    expect(result).toMatchObject({
      source: 'chart',
      returned: 10,
      totalCount: 80,
      truncated: true,
      chartSampleTruncated: true,
      appliedViewRules: false,
      hasUnboundedProvenance: true,
    });
    expect(result.chart?.buckets).toHaveLength(10);
    expect(result.chart).toMatchObject({ truncated: false, unplaced: 3, children: 80 });
    expect(result.limits.join(' ')).toContain('does not apply');
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it('caps split series and aligned cells even if a future Core sends a larger chart', async () => {
    const fake = setup({ kind: 'chart', filters: [] });
    const original = fake.query.getMockImplementation() as
      ((endpoint: { operation: string }) => Promise<unknown>) | undefined;
    fake.query.mockImplementation(async (endpoint: { operation: string }) => {
      const value = (await original?.(endpoint)) as Record<string, unknown>;
      if (endpoint.operation !== 'chart.run') return value;
      return {
        ...value,
        series: Array.from({ length: 30 }, (_, i) => ({
          value: String(i),
          other: false,
          children: 1,
          total: null,
        })),
        buckets: [
          {
            value: 'Ready',
            children: 30,
            total: null,
            cells: Array.from({ length: 30 }, () => ({ children: 1, total: null })),
          },
        ],
      };
    });
    const result = await readView(
      fake.ports,
      workspaceId,
      itemId,
      '{"viewId":"work"}',
      fake.signal,
    );
    expect(result.chart?.series).toHaveLength(7);
    expect(result.chart?.buckets[0]?.cells).toHaveLength(7);
    expect(result).toMatchObject({
      appliedViewRules: true,
      chartSampleTruncated: true,
      truncated: true,
    });
  });

  it.each([
    'not json',
    '{"viewId":"work","pageSize":26}',
    '{"viewId":"work","pageSize":0}',
    '{"viewId":"work","filters":[]}',
    '{"viewId":"work","cursor":"next"}',
    '{}',
  ])('refuses invalid or unsupported sample arguments before I/O: %s', async (args) => {
    const fake = setup();
    await expect(readView(fake.ports, workspaceId, itemId, args, fake.signal)).rejects.toThrow();
    expect(fake.query).not.toHaveBeenCalled();
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it('does not turn a Core refusal into an empty result', async () => {
    const fake = setup();
    fake.execute.mockRejectedValue(new Error('items.locked'));
    await expect(
      readView(fake.ports, workspaceId, itemId, '{"viewId":"work"}', fake.signal),
    ).rejects.toThrow('items.locked');
  });

  it('refuses an unrenderable view before reading data', async () => {
    const fake = setup();
    const original = fake.query.getMockImplementation() as
      ((endpoint: { operation: string }) => Promise<unknown>) | undefined;
    fake.query.mockImplementation((endpoint: { operation: string }) =>
      endpoint.operation === 'views.getConfigurations'
        ? Promise.resolve({ views: [view], unrenderable: ['work'], default: 'work' })
        : original?.(endpoint),
    );
    await expect(
      readView(fake.ports, workspaceId, itemId, '{"viewId":"work"}', fake.signal),
    ).rejects.toThrow('unrenderable');
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it('reports computed filter evidence as unavailable instead of asserting no matches', async () => {
    const fake = setup({
      filters: [{ property: 'effort', operator: 'greater-than', value: '10' }],
    });
    const original = fake.query.getMockImplementation() as
      ((endpoint: { operation: string }) => Promise<unknown>) | undefined;
    fake.query.mockImplementation((endpoint: { operation: string }) =>
      endpoint.operation === 'schema.get'
        ? Promise.resolve({ properties: [{ key: 'effort', type: 'formula', label: 'Effort' }] })
        : original?.(endpoint),
    );
    const result = await readView(
      fake.ports,
      workspaceId,
      itemId,
      '{"viewId":"work"}',
      fake.signal,
    );
    expect(result).toMatchObject({
      source: 'configuration_only',
      totalCount: null,
      appliedViewRules: false,
    });
    expect(result.limits.join(' ')).toContain('not an empty view');
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it('bounds aggregate work and states ordering limits', async () => {
    const fake = setup({
      sorts: [
        { property: 'due', descending: false },
        { property: 'hours', descending: true },
      ],
      aggregates: Array.from({ length: 10 }, (_, i) => ({
        property: `value${String(i)}`,
        function: 'sum',
      })),
    });
    const result = await readView(
      fake.ports,
      workspaceId,
      itemId,
      '{"viewId":"work"}',
      fake.signal,
    );
    expect(result.aggregates).toHaveLength(4);
    expect(fake.execute).toHaveBeenCalledTimes(6);
    expect(result.limits.join(' ')).toContain('only the first saved sort key');
    expect(result.limits.join(' ')).toContain('At most 4 configured summaries');
  });

  it.each(['outline', 'form', 'interactive_form', 'habit_tracker', 'drive'])(
    'does not present unused saved rules as the renderer output for %s',
    async (kind) => {
      const fake = setup({ kind });
      const result = await readView(
        fake.ports,
        workspaceId,
        itemId,
        '{"viewId":"work"}',
        fake.signal,
      );
      const command = fake.execute.mock.calls[0]?.[0] as {
        body: { filters: unknown[]; sort: unknown };
      };
      expect(command.body).toMatchObject({ filters: [], sort: null });
      expect(result.appliedViewRules).toBe(false);
      expect(result.limits.join(' ')).toContain('does not apply saved filters or sorting');
      expect(result.aggregates).toEqual([]);
      expect(fake.execute).toHaveBeenCalledTimes(2);
    },
  );
});
