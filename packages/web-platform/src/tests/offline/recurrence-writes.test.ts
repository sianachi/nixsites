import { describe, expect, it } from 'vitest';

import type { MirrorReader } from '../../offline/mirror-fetch';
import { planViewWrite } from '../../offline/view-writes';

const ITEM = '0194f0aa-0000-7000-8000-000000000001';

describe('offline recurrence writes', () => {
  // The outbox has no operation for the rule column, so a completion must say it needs a connection
  // rather than be queued as something that would not replay.
  it('does not queue a completion, which the replay outbox cannot carry', async () => {
    const planned = await planViewWrite(
      {} as MirrorReader,
      'POST',
      `/api/v1/items/${ITEM}/recurrence/completions`,
      { occurredOn: '2026-03-02' },
    );
    expect(planned).toBeNull();
  });

  it('does not queue setting a rule either', async () => {
    const planned = await planViewWrite(
      {} as MirrorReader,
      'PUT',
      `/api/v1/items/${ITEM}/recurrence`,
      {
        freq: 'daily',
        interval: 1,
      },
    );
    expect(planned).toBeNull();
  });
});
