import { afterEach, describe, expect, it } from 'vitest';

import { boot, type Booted } from '../testing/testing.ts';

const open: Booted[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

describe('recipient metadata', () => {
  it('reads opaque connection metadata without starting the provider or checking account status', async () => {
    let launches = 0;
    const app = await boot({
      launch: () => {
        launches += 1;
        throw new Error('Provider startup is forbidden for metadata');
      },
    });
    open.push(app);

    const response = await app.call({
      operation: 'recipient_metadata',
      provider: 'chatgpt',
      apiKey: 'synthetic-secret-never-returned',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ provider: 'chatgpt', connectionRevision: 'unknown' });
    expect(launches).toBe(0);
    expect(app.manager.accounts.size).toBe(0);
    expect(app.fake.calls).toEqual([]);
    expect(app.logger.text()).not.toContain('synthetic-secret-never-returned');
  });
});
