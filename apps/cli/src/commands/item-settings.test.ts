import { describe, expect, it, vi } from 'vitest';
import { executeItemSettings, itemSettings } from './item-settings.ts';
import { outputOptions } from '../output.ts';
import type { Session } from '../session.ts';

const ID = '11111111-1111-4111-8111-111111111111';
const output = outputOptions(true, { isTTY: false });

describe('nixctl item settings', () => {
  it('rejects an item id that is not a UUID', async () => {
    await expect(itemSettings(undefined, 'nope', {}, output)).rejects.toThrow(
      'The item must be a UUID',
    );
  });

  it('rejects a bad switch value naming the flag', async () => {
    await expect(itemSettings(undefined, ID, { reviewStates: 'maybe' }, output)).rejects.toThrow(
      '--review-states',
    );
  });

  it('sends only the switches named and null for the rest', async () => {
    const execute = vi.fn().mockResolvedValue({
      id: ID,
      title: 'T',
      settings: { comments: true, suggesting: false, reviewStates: false, fullWidth: false },
    });
    const session = { client: { execute } } as unknown as Session;

    await executeItemSettings(session, ID, { comments: 'on' });

    const request = execute.mock.calls[0]?.[0] as { body: Record<string, unknown> };
    expect(request.body).toEqual({
      comments: true,
      suggesting: null,
      reviewStates: null,
      fullWidth: null,
    });
  });
});
