import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { Site } from '@nix/api-client';
import { outputOptions } from '../output.ts';
import { makeProfile } from './cli.test-helper.ts';
import {
  addHostname,
  describeHostnames,
  reject,
  removeHostname,
  requestApproval,
} from './site-hostnames.ts';

const API = 'http://nix.test';
const SITE = '31111111-1111-4111-8111-111111111111';
const JSON_OUT = outputOptions(true, { isTTY: false });

const server = setupServer(
  http.post(`${API}/public/v1/auth/token`, () =>
    HttpResponse.json({ accessToken: 'jwt-1', tokenType: 'Bearer', expiresInSeconds: 600 }),
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const custom = {
  hostname: 'osinachi.nwagboso.com',
  url: 'https://osinachi.nwagboso.com/',
  kind: 'custom',
  verified: false,
  primary: true,
  serveMode: 'serve',
  status: 'pending',
  checkedAt: '2026-10-11T08:00:00+00:00',
  checkError: 'txt_missing',
  managed: false,
  records: [
    {
      type: 'TXT',
      name: '_nix-site.osinachi.nwagboso.com',
      value: 'nix-site-verification=abc',
      purpose: 'verification',
    },
    { type: 'CNAME', name: 'osinachi.nwagboso.com', value: 'nixsites.com', purpose: 'routing' },
  ],
} as const;

function site(): Record<string, unknown> {
  return {
    id: SITE,
    workspaceId: '34444444-4444-4444-8444-444444444444',
    rootItemId: '32222222-2222-4222-8222-222222222222',
    slug: 'osinachi',
    layout: 'blog',
    settings: {
      name: 'Osinachi',
      description: '',
      accent: '#2f6f4f', // design-token-exempt: a site owner's chosen accent, data rather than styling.
      navigation: [],
      footerText: '',
      builtWithNix: true,
      language: 'en',
    },
    republishMode: 'manual',
    debounceSeconds: 300,
    status: 'draft',
    canManage: true,
    hostnames: [custom],
    excludedItemIds: [],
    datedCollections: [],
    liveBuild: null,
    latestBuild: null,
    createdAt: '2026-10-11T08:00:00+00:00',
    updatedAt: '2026-10-11T08:00:00+00:00',
    primaryHostname: 'osinachi.nwagboso.com',
    approvalRequired: true,
    approval: null,
  };
}

const withProfile = () => makeProfile({ apiUrl: API, token: 'nixpat_abc' });

describe('site hostnames and approvals', () => {
  it('adds a hostname with its serve mode and refuses an unknown mode before sending', async () => {
    const { env, done } = await withProfile();
    let body: unknown;
    server.use(
      http.post(`${API}/api/v1/sites/${SITE}/hostnames`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(site());
      }),
    );
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await addHostname('default', SITE, 'osinachi.nwagboso.com', { mode: 'redirect' }, JSON_OUT, {
        env,
      });
      await expect(
        addHostname('default', SITE, 'x.example.com', { mode: 'bounce' }, JSON_OUT, { env }),
      ).rejects.toThrow(/serve/);
    } finally {
      write.mockRestore();
    }
    expect(body).toEqual({ hostname: 'osinachi.nwagboso.com', serveMode: 'redirect' });
    await done();
  });

  it('needs --yes to remove a hostname or to ask for approval', async () => {
    await expect(removeHostname('default', SITE, 'a.example.com', false, JSON_OUT)).rejects.toThrow(
      /--yes/,
    );
    await expect(requestApproval('default', SITE, false, JSON_OUT)).rejects.toThrow(/--yes/);
  });

  it('sends the rejection note', async () => {
    const { env, done } = await withProfile();
    let body: unknown;
    server.use(
      http.post(`${API}/api/v1/sites/${SITE}/approval/reject`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          siteId: SITE,
          workspaceId: '34444444-4444-4444-8444-444444444444',
          slug: 'osinachi',
          name: 'Osinachi',
          hostnames: ['osinachi.nixsites.com'],
          requestedBy: '35555555-5555-4555-8555-555555555555',
          approval: {
            state: 'rejected',
            requestedAt: '2026-10-11T08:00:00+00:00',
            decidedAt: '2026-10-11T09:00:00+00:00',
            note: 'Not yet',
          },
          build: null,
        });
      }),
    );
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await reject('default', SITE, 'Not yet', JSON_OUT, { env });
    } finally {
      write.mockRestore();
    }
    expect(body).toEqual({ note: 'Not yet' });
    await done();
  });

  it('describes a pending hostname with the records still to create', () => {
    const text = describeHostnames(site() as unknown as Site);
    expect(text).toContain('osinachi.nwagboso.com  (custom, pending, primary, txt_missing)');
    expect(text).toContain('TXT _nix-site.osinachi.nwagboso.com nix-site-verification=abc');
    expect(text).toContain('CNAME osinachi.nwagboso.com nixsites.com');
  });
});
