import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadWebConfig, WEB_CONFIG_OFF } from '../../lib/web-config';

/** The install's front-door switches: on only when the file says so, off on anything else. */
describe('loadWebConfig', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads both switches from the served file', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ landing: true, demo: false })),
    );

    await expect(loadWebConfig()).resolves.toEqual({ landing: true, demo: false });
  });

  it('stays off where the file is not served and the SPA answers with index.html', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<!doctype html><html></html>')));

    await expect(loadWebConfig()).resolves.toEqual(WEB_CONFIG_OFF);
  });

  it('stays off for a value that is not a boolean', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ landing: 'yes', demo: true })),
    );

    await expect(loadWebConfig()).resolves.toEqual(WEB_CONFIG_OFF);
  });

  it('stays off when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(loadWebConfig()).resolves.toEqual(WEB_CONFIG_OFF);
  });
});
