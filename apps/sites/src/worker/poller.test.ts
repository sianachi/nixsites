import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LeaseJob } from './dispatch.ts';
import { Poller } from './poller.ts';

const job = (kind: string): LeaseJob => ({
  id: '10000000-0000-4000-8000-000000000001',
  tenantId: 't',
  workspaceId: 'w',
  actorId: 'a',
  kind,
  payload: {},
  attempts: 1,
  cancellationRequested: false,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Poller', () => {
  it('leases exactly one job per kind under a worker-prefixed execution id and runs it', async () => {
    const leased: { kind: string; owner: string }[] = [];
    const ran: { kind: string; owner: string }[] = [];
    const poller = new Poller({
      core: {
        lease: (kind, owner) => {
          leased.push({ kind, owner });
          return Promise.resolve(kind === 'site.build' ? [job(kind)] : []);
        },
      },
      runner: {
        run: (leasedJob, owner) => {
          ran.push({ kind: leasedJob.kind, owner });
          return Promise.resolve('completed');
        },
      },
      kinds: ['site.build', 'site.activate'],
      workerId: 'sites-test',
      leaseSeconds: 60,
      pollSeconds: 5,
      concurrency: 1,
      newId: () => '0b8f6a3e-0000-4000-8000-000000000000',
    });

    expect(await poller.poll()).toBe(true);
    expect(leased.map((entry) => entry.kind)).toEqual(['site.build', 'site.activate']);
    expect(ran).toEqual([
      { kind: 'site.build', owner: 'sites-test:0b8f6a3e-0000-4000-8000-000000000000' },
    ]);
  });

  it('keeps polling after a lease failure and sleeps only when nothing ran', async () => {
    let calls = 0;
    const poller = new Poller({
      core: {
        lease: () => {
          calls += 1;
          return calls === 1 ? Promise.reject(new Error('down')) : Promise.resolve([]);
        },
      },
      runner: { run: () => Promise.resolve('completed') },
      kinds: ['site.build'],
      workerId: 'sites-test',
      leaseSeconds: 60,
      pollSeconds: 5,
      concurrency: 1,
    });
    const stopping = new AbortController();
    const running = poller.run(stopping.signal);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(calls).toBe(3);
    stopping.abort();
    await running;
  });
});
