import { describe, expect, it, vi } from 'vitest';

import { rolesReady, startRoles, stopAll, type Starters } from './lifecycle.ts';

describe('node host lifecycle', () => {
  it('stops already started roles when a later role fails to start', async () => {
    const stop = vi.fn(() => Promise.resolve());
    const starters: Starters = {
      collab: () => Promise.resolve({ stop }),
      companion: () => Promise.reject(new Error('port in use')),
      'sites-worker': () => Promise.resolve({ stop }),
    };
    await expect(startRoles(['collab', 'companion', 'sites-worker'], starters)).rejects.toThrow(
      'port in use',
    );
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('lets every role settle when one stop rejects or hangs', async () => {
    const stopped = vi.fn();
    const failures = await stopAll(
      [
        { stop: () => Promise.reject(new Error('boom')) },
        {
          stop: () => {
            stopped();
            return Promise.resolve();
          },
        },
      ],
      50,
    );
    expect(stopped).toHaveBeenCalled();
    expect(failures).toHaveLength(1);
    const hung = await stopAll([{ stop: () => new Promise<void>(() => undefined) }], 20);
    expect(String(hung[0])).toMatch(/did not stop/);
  });

  it('checks readiness only for configured roles', async () => {
    const probe = vi.fn((role: string) => Promise.resolve(role !== 'sites-worker'));
    expect(await rolesReady(['collab', 'companion'], probe)).toBe(true);
    expect(probe).not.toHaveBeenCalledWith('sites-worker');
    expect(await rolesReady(['collab', 'sites-worker'], probe)).toBe(false);
  });
});
