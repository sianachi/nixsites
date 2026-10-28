import type { Site } from '@nix/api-client';
import type { ReactElement } from 'react';

import { settingsPanelWidth } from '@nix/web-foundation/layout/regions';
import { SiteApprovalView } from './site-approval';
import { SiteHostnamesView } from './site-hostnames';

export default { title: 'Nix/Sites/Hostnames', parameters: { layout: 'padded' } };

const base: Site = {
  id: 'e1111111-1111-4111-8111-111111111111',
  workspaceId: 'e2222222-2222-4222-8222-222222222222',
  rootItemId: 'e3333333-3333-4333-8333-333333333333',
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
    noindex: false,
    author: null,
    headingMark: 'square',
    typeface: 'rounded',
    spacing: 'comfortable',
  },
  republishMode: 'manual',
  debounceSeconds: 300,
  status: 'published',
  canManage: true,
  hostnames: [
    {
      hostname: 'osinachi.nixsites.com',
      url: 'https://osinachi.nixsites.com/',
      kind: 'default',
      verified: true,
      primary: false,
      serveMode: 'serve',
      status: 'verified',
      checkedAt: null,
      checkError: null,
      managed: false,
      records: [],
    },
    {
      hostname: 'osinachi.nwagboso.com',
      url: 'https://osinachi.nwagboso.com/',
      kind: 'custom',
      verified: true,
      primary: true,
      serveMode: 'serve',
      status: 'verified',
      checkedAt: '2026-10-11T09:00:00+00:00',
      checkError: null,
      managed: true,
      records: [],
    },
    {
      hostname: 'blog.example.org',
      url: 'https://blog.example.org/',
      kind: 'custom',
      verified: false,
      primary: false,
      serveMode: 'redirect',
      status: 'pending',
      checkedAt: '2026-10-11T09:05:00+00:00',
      checkError: 'txt_missing',
      managed: false,
      records: [
        {
          type: 'TXT',
          name: '_nix-site.blog.example.org',
          value: 'nix-site-verification=0123456789abcdef0123456789abcdef',
          purpose: 'verification',
        },
        { type: 'CNAME', name: 'blog.example.org', value: 'nixsites.com', purpose: 'routing' },
      ],
    },
  ],
  excludedItemIds: [],
  datedCollections: [],
  liveBuild: null,
  latestBuild: null,
  createdAt: '2026-10-11T08:00:00+00:00',
  updatedAt: '2026-10-11T08:00:00+00:00',
  primaryHostname: 'osinachi.nwagboso.com',
  approvalRequired: false,
  approval: null,
};

const accept = (): Promise<string | null> => Promise.resolve(null);

function Panel({ children }: { children: ReactElement }): ReactElement {
  return <div className={settingsPanelWidth}>{children}</div>;
}

/** Both addresses serve; the custom one is canonical; a third waits for its records. */
export function PortfolioWithPendingAlias(): ReactElement {
  return (
    <Panel>
      <SiteHostnamesView site={base} run={accept} />
    </Panel>
  );
}

/** Empty: only the default address. */
export function DefaultOnly(): ReactElement {
  return (
    <Panel>
      <SiteHostnamesView
        site={{
          ...base,
          primaryHostname: null,
          hostnames: base.hostnames.slice(0, 1).map((entry) => ({ ...entry, primary: true })),
        }}
        run={accept}
      />
    </Panel>
  );
}

/** Error: a verified hostname whose record disappeared, and a refusal after an action. */
export function Failing(): ReactElement {
  return (
    <Panel>
      <SiteHostnamesView
        site={{
          ...base,
          hostnames: base.hostnames.map((entry) =>
            entry.kind === 'custom' && entry.managed
              ? { ...entry, status: 'failing' as const, checkError: 'txt_missing' }
              : entry,
          ),
        }}
        run={() =>
          Promise.resolve(
            'A build or a change of what is live is under way. Try again in a moment.',
          )
        }
      />
    </Panel>
  );
}

export function ReaderView(): ReactElement {
  return (
    <Panel>
      <SiteHostnamesView site={{ ...base, canManage: false }} run={accept} />
    </Panel>
  );
}

/** Loading-like partial state: a hostname added a moment ago, not checked yet. */
export function Checking(): ReactElement {
  return (
    <Panel>
      <SiteHostnamesView
        site={{
          ...base,
          hostnames: base.hostnames.map((entry) =>
            entry.status === 'pending'
              ? { ...entry, status: 'checking' as const, checkedAt: null, checkError: null }
              : entry,
          ),
        }}
        run={accept}
      />
    </Panel>
  );
}

export function WaitingForApproval(): ReactElement {
  return (
    <Panel>
      <SiteApprovalView
        site={{
          ...base,
          status: 'draft',
          approvalRequired: true,
          approval: {
            state: 'pending',
            requestedAt: '2026-10-11T09:00:00+00:00',
            decidedAt: null,
            note: null,
          },
        }}
        request={() => Promise.resolve({ site: null, error: null })}
      />
    </Panel>
  );
}

export function ApprovalNeeded(): ReactElement {
  return (
    <Panel>
      <SiteApprovalView
        site={{ ...base, status: 'draft', approvalRequired: true }}
        request={() =>
          Promise.resolve({ site: null, error: 'The request did not complete. Try again.' })
        }
      />
    </Panel>
  );
}
