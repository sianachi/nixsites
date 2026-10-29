import { describe, expect, it, vi } from 'vitest';

import { createQueryTools, LOCKED_RESULT, QUERY_TOOLS } from '../../openui/tool-provider';

const workspace = '11111111-1111-4111-8111-111111111111';
const outcome = (text: string, lockedContent = false) => ({
  text,
  readOnly: true,
  touchedParents: [],
  lockedContent,
});

describe('openui query tools', () => {
  it('offers reads only', () => {
    expect(Object.keys(createQueryTools([workspace], vi.fn()))).toEqual([...QUERY_TOOLS]);
  });

  it('runs a read in the default workspace with complete tool arguments', async () => {
    const run = vi.fn().mockResolvedValue(outcome('{"results":[],"truncated":false}'));
    const tools = createQueryTools([workspace], run);
    await expect(tools.search({ query: 'plans' })).resolves.toEqual({
      results: [],
      truncated: false,
    });
    expect(run).toHaveBeenCalledWith(workspace, expect.any(String));
    expect(JSON.parse(run.mock.calls[0]?.[1] as string)).toMatchObject({
      operation: 'search',
      query: 'plans',
      itemId: '',
      specJson: '',
    });
  });

  it('passes a calendar range as the spec', async () => {
    const run = vi.fn().mockResolvedValue(outcome('{}'));
    await createQueryTools([workspace], run).read_calendar({
      from: '2026-10-19',
      to: '2026-10-25',
    });
    expect((JSON.parse(run.mock.calls[0]?.[1] as string) as { specJson: string }).specJson).toBe(
      '{"from":"2026-10-19","to":"2026-10-25"}',
    );
  });

  it('refuses a workspace outside its scope', async () => {
    const run = vi.fn();
    await expect(
      createQueryTools([workspace], run).list_items({
        workspaceId: '99999999-9999-4999-8999-999999999999',
      }),
    ).rejects.toThrow('not available');
    expect(run).not.toHaveBeenCalled();
  });

  it('returns a locked stub instead of data under a lock', async () => {
    const run = vi.fn().mockResolvedValue(outcome('{"items":[{"title":"Secret"}]}', true));
    await expect(createQueryTools([workspace], run).list_items({})).resolves.toEqual(LOCKED_RESULT);
  });
});
