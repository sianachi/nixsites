import { describe, expect, it, vi } from 'vitest';
import { executeProtect, protect } from './protection.ts';
import { outputOptions } from '../output.ts';
import type { Session } from '../session.ts';

const ID = '11111111-1111-4111-8111-111111111111';
const output = outputOptions(true, { isTTY: false });

describe('nixctl item protect validation', () => {
  it('rejects an item id that is not a UUID', async () => {
    await expect(protect(undefined, 'not-a-uuid', {}, output)).rejects.toThrow(
      'The item must be a UUID',
    );
  });

  it.each([
    ['--delete', { delete: 'maybe' }],
    ['--children', { children: 'yes' }],
  ])('rejects a bad %s value naming the flag', async (flag, options) => {
    await expect(protect(undefined, ID, options, output)).rejects.toThrow(flag);
  });

  it('sends noDelete and leaves noChildren unset when only --delete is given', async () => {
    const execute = vi.fn().mockResolvedValue({
      id: ID,
      title: 'T',
      noDelete: true,
      noChildren: false,
      collaboration: true,
      managedBy: null,
    });
    const session = { client: { execute } } as unknown as Session;

    await executeProtect(session, ID, { delete: 'on' });

    const request = execute.mock.calls[0]?.[0] as { body: Record<string, unknown> };
    expect(request.body).toMatchObject({ noDelete: true, noChildren: null });
  });
});
