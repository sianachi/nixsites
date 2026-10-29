import type { Site, SiteBuild } from '@nix/api-client';

export const SITE_ID = 'c1111111-1111-4111-8111-111111111111';
export const ROOT_ID = 'c2222222-2222-4222-8222-222222222222';
export const WORKSPACE_ID = 'c3333333-3333-4333-8333-333333333333';
export const BUILD_ID = 'c4444444-4444-4444-8444-444444444444';
export const OLD_BUILD_ID = 'c5555555-5555-4555-8555-555555555555';

export function siteBuild(overrides: Partial<SiteBuild> = {}): SiteBuild {
  return {
    id: BUILD_ID,
    siteId: SITE_ID,
    status: 'live',
    origin: 'manual',
    pageCount: 12,
    fileCount: 30,
    totalBytes: 4096,
    loss: [],
    failureCode: null,
    createdAt: '2026-10-11T09:00:00+00:00',
    activatedAt: '2026-10-11T09:00:05+00:00',
    ...overrides,
  };
}

export function site(overrides: Partial<Site> = {}): Site {
  return {
    id: SITE_ID,
    workspaceId: WORKSPACE_ID,
    rootItemId: ROOT_ID,
    slug: 'garden',
    layout: 'docs',
    settings: {
      name: 'Garden notes',
      description: 'What grew and what did not.',
      accent: '#2f6f4f', // design-token-exempt: a site owner's chosen accent, data rather than styling.
      navigation: [],
      footerText: '',
      builtWithNix: true,
      language: 'en',
      noindex: false,
      author: null,
      headingMark: 'square',
      typeface: 'rounded',
      spacing: 'comfortable',
    },
    republishMode: 'manual',
    debounceSeconds: 300,
    status: 'draft',
    canManage: true,
    hostnames: [
      {
        hostname: 'garden.nixsites.com',
        url: 'https://garden.nixsites.com/',
        kind: 'default',
        verified: true,
        primary: true,
        serveMode: 'serve',
        status: 'verified',
        checkedAt: null,
        checkError: null,
        managed: false,
        records: [],
      },
    ],
    excludedItemIds: [],
    datedCollections: [],
    liveBuild: null,
    latestBuild: null,
    createdAt: '2026-10-11T08:00:00+00:00',
    updatedAt: '2026-10-11T08:00:00+00:00',
    primaryHostname: null,
    approvalRequired: false,
    approval: null,
    ...overrides,
  };
}

export function publishedSite(overrides: Partial<Site> = {}): Site {
  const live = siteBuild({
    loss: [
      'mermaid-as-code: The diagram on /plans/ is shown as code.',
      'views-not-rendered: The board on /beds/ was left out.',
    ],
  });
  return site({
    status: 'published',
    liveBuild: live,
    latestBuild: live,
    hostnames: [
      ...site().hostnames,
      {
        hostname: 'garden.example.com',
        url: 'https://garden.example.com/',
        kind: 'custom',
        verified: false,
        primary: false,
        serveMode: 'serve',
        status: 'pending',
        checkedAt: '2026-10-11T08:05:00+00:00',
        checkError: 'txt_missing',
        managed: false,
        records: [
          {
            type: 'TXT',
            name: '_nix-site.garden.example.com',
            value: 'nix-site-verification=0123456789abcdef0123456789abcdef',
            purpose: 'verification',
          },
          { type: 'CNAME', name: 'garden.example.com', value: 'nixsites.com', purpose: 'routing' },
        ],
      },
    ],
    ...overrides,
  });
}
