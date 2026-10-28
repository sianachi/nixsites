import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { outputOptions } from '../output.ts';
import { captureJson, makeProfile } from './cli.test-helper.ts';
import {
  mergeDated,
  parseDated,
  parseNavLink,
  publishSite,
  unpublishSite,
  updateSite,
} from './sites.ts';

const API = 'http://nix.test';
const SITE = '21111111-1111-4111-8111-111111111111';
const ROOT = '22222222-2222-4222-8222-222222222222';
const BUILD = '23333333-3333-4333-8333-333333333333';
const WORKSPACE = '24444444-4444-4444-8444-444444444444';

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

function build(status: string): Record<string, unknown> {
  return {
    id: BUILD,
    siteId: SITE,
    status,
    origin: 'manual',
    pageCount: 3,
    fileCount: 9,
    totalBytes: 1024,
    loss: [],
    failureCode: status === 'failed' ? 'site_render_failed' : null,
    createdAt: '2026-10-11T09:00:00+00:00',
    activatedAt: status === 'live' ? '2026-10-11T09:00:03+00:00' : null,
  };
}

function site(status = 'draft', datedCollections: unknown[] = []): Record<string, unknown> {
  return {
    id: SITE,
    workspaceId: WORKSPACE,
    rootItemId: ROOT,
    slug: 'garden',
    layout: 'docs',
    settings: {
      name: 'Garden',
      description: '',
      accent: '#2f6f4f', // design-token-exempt: a site owner's chosen accent, data rather than styling.
      navigation: [],
      footerText: '',
      builtWithNix: true,
      language: 'en',
    },
    republishMode: 'manual',
    debounceSeconds: 300,
    status,
    canManage: true,
    hostnames: [],
    excludedItemIds: [],
    datedCollections,
    liveBuild: status === 'published' ? build('live') : null,
    latestBuild: null,
    createdAt: '2026-10-11T08:00:00+00:00',
    updatedAt: '2026-10-11T08:00:00+00:00',
    primaryHostname: null,
    approvalRequired: false,
    approval: null,
  };
}

const withProfile = () => makeProfile({ apiUrl: API, token: 'nixpat_abc' });

describe('the site commands over a stubbed Core', () => {
  it('refuses a first publish without --yes and sends nothing', async () => {
    const { env, done } = await withProfile();
    const published = vi.fn();
    server.use(
      http.get(`${API}/api/v1/sites/${SITE}`, () => HttpResponse.json(site())),
      http.post(`${API}/api/v1/sites/${SITE}/publish`, () => {
        published();
        return HttpResponse.json(build('queued'), { status: 202 });
      }),
    );

    await expect(
      publishSite('default', SITE, {}, outputOptions(true, { isTTY: false }), { env }),
    ).rejects.toThrow(/--yes/);
    expect(published).not.toHaveBeenCalled();
    await done();
  });

  it('refuses to publish an unpublished site again without --yes', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.get(`${API}/api/v1/sites/${SITE}`, () => HttpResponse.json(site('unpublished'))),
    );

    await expect(
      publishSite('default', SITE, {}, outputOptions(true, { isTTY: false }), { env }),
    ).rejects.toThrow(/--yes/);
    await done();
  });

  it('acknowledges the disclosure with --yes and waits until the build is live', async () => {
    const { env, done } = await withProfile();
    let body: unknown;
    let polls = 0;
    server.use(
      http.get(`${API}/api/v1/sites/${SITE}`, () => HttpResponse.json(site())),
      http.post(`${API}/api/v1/sites/${SITE}/publish`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(build('queued'), { status: 202 });
      }),
      http.get(`${API}/api/v1/sites/${SITE}/builds/${BUILD}`, () => {
        polls += 1;
        return HttpResponse.json(build(polls < 2 ? 'building' : 'live'));
      }),
    );

    const printed = await captureJson((json) =>
      publishSite('default', SITE, { yes: true, wait: true }, json, { env, pollMs: 1 }),
    );

    expect(body).toMatchObject({ acknowledgeDisclosure: true, refreshPaths: false });
    expect(printed).toMatchObject({ id: BUILD, status: 'live', pageCount: 3 });
    await done();
  });

  it('fails a waited publish whose build failed', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.get(`${API}/api/v1/sites/${SITE}`, () => HttpResponse.json(site('published'))),
      http.post(`${API}/api/v1/sites/${SITE}/publish`, () =>
        HttpResponse.json(build('queued'), { status: 202 }),
      ),
      http.get(`${API}/api/v1/sites/${SITE}/builds/${BUILD}`, () =>
        HttpResponse.json(build('failed')),
      ),
    );

    await expect(
      captureJson((json) => publishSite('default', SITE, { wait: true }, json, { env, pollMs: 1 })),
    ).rejects.toThrow(/failed \(site_render_failed\)/);
    await done();
  });

  it('keeps the other settings when only the name changes', async () => {
    const { env, done } = await withProfile();
    let body: unknown;
    server.use(
      http.get(`${API}/api/v1/sites/${SITE}`, () =>
        HttpResponse.json(
          site('draft', [
            {
              itemId: WORKSPACE,
              dateProperty: 'when',
              tagsProperty: null,
              coverProperty: null,
              summaryProperty: null,
            },
          ]),
        ),
      ),
      http.patch(`${API}/api/v1/sites/${SITE}`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(site());
      }),
    );

    await captureJson((json) =>
      updateSite(
        'default',
        SITE,
        { name: 'Allotment', mode: 'auto', yes: true, dated: [`${ROOT}:published:tags`] },
        json,
        { env },
      ),
    );

    expect(body).toMatchObject({
      settings: { name: 'Allotment', accent: '#2f6f4f', builtWithNix: true }, // design-token-exempt: a site owner's chosen accent.
      republishMode: 'auto',
      datedCollections: [
        { itemId: WORKSPACE, dateProperty: 'when' },
        { itemId: ROOT, dateProperty: 'published', tagsProperty: 'tags' },
      ],
      excludedItemIds: null,
    });
    await done();
  });

  it('replaces navigation and the footer settings, keeping the rest', async () => {
    const { env, done } = await withProfile();
    let body: unknown;
    server.use(
      http.get(`${API}/api/v1/sites/${SITE}`, () => HttpResponse.json(site())),
      http.patch(`${API}/api/v1/sites/${SITE}`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(site());
      }),
    );

    await captureJson((json) =>
      updateSite(
        'default',
        SITE,
        {
          nav: ['Get started=/getting-started/', 'Blog=/blog/'],
          footer: 'Hi',
          builtWithNix: false,
        },
        json,
        { env },
      ),
    );

    expect(body).toMatchObject({
      settings: {
        accent: '#2f6f4f', // design-token-exempt: a site owner's chosen accent.
        navigation: [
          { label: 'Get started', path: '/getting-started/' },
          { label: 'Blog', path: '/blog/' },
        ],
        footerText: 'Hi',
        builtWithNix: false,
      },
    });
    await done();
  });

  it('hides a site from search engines and names its author, keeping the rest', async () => {
    const { env, done } = await withProfile();
    let body: unknown;
    server.use(
      http.get(`${API}/api/v1/sites/${SITE}`, () => HttpResponse.json(site())),
      http.patch(`${API}/api/v1/sites/${SITE}`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(site());
      }),
    );

    await captureJson((json) =>
      updateSite('default', SITE, { noindex: true, author: ' Ada Writer ' }, json, { env }),
    );

    expect(body).toMatchObject({
      settings: { name: 'Garden', builtWithNix: true, noindex: true, author: 'Ada Writer' },
    });
    await done();
  });

  it('refuses an unknown typeface, heading mark or spacing before calling Core', async () => {
    const json = outputOptions(true, { isTTY: false });
    await expect(updateSite('default', SITE, { typeface: 'comic' }, json)).rejects.toThrow(
      /--typeface must be rounded, serif, legible/,
    );
    await expect(updateSite('default', SITE, { headingMark: 'star' }, json)).rejects.toThrow(
      /--heading-mark/,
    );
    await expect(updateSite('default', SITE, { spacing: 'huge' }, json)).rejects.toThrow(
      /--spacing/,
    );
  });

  it('rejects a navigation link without a label or a site path', () => {
    expect(parseNavLink('A=b=/x/')).toEqual({ label: 'A=b', path: '/x/' });
    expect(() => parseNavLink('/blog/')).toThrow(/--nav/);
    expect(() => parseNavLink('Blog=https://x')).toThrow(/--nav/);
  });

  it('needs --yes to switch to auto mode', async () => {
    await expect(
      updateSite('default', SITE, { mode: 'auto' }, outputOptions(true, { isTTY: false })),
    ).rejects.toThrow(/--yes/);
  });

  it('needs --yes to unpublish', async () => {
    await expect(
      unpublishSite('default', SITE, false, outputOptions(true, { isTTY: false })),
    ).rejects.toThrow(/--yes/);
  });

  it('parses dated collection specs and rejects malformed ones', () => {
    expect(parseDated(`${ROOT}:date`)).toEqual({
      itemId: ROOT,
      dateProperty: 'date',
      tagsProperty: null,
      coverProperty: null,
      summaryProperty: null,
    });
    expect(parseDated(`${ROOT}:date::cover:summary`)).toEqual({
      itemId: ROOT,
      dateProperty: 'date',
      tagsProperty: null,
      coverProperty: 'cover',
      summaryProperty: 'summary',
    });
    expect(() => parseDated(ROOT)).toThrow(/dated collection/);
    expect(() => parseDated(`${ROOT}:a:b:c:d:e`)).toThrow(/dated collection/);
  });

  it('merges dated collections: an added one replaces its own item, removed ones go', () => {
    const old = parseDated(`${ROOT}:date`);
    const other = parseDated(`${WORKSPACE}:when`);
    const fresh = parseDated(`${ROOT}:published:tags`);
    expect(mergeDated([old, other], [fresh], [])).toEqual([other, fresh]);
    expect(mergeDated([old, other], [], [WORKSPACE])).toEqual([old]);
  });
});
