import { createNixClient, type NixClient, type Workspace } from '@nix/api-client';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { WorkspaceProvider } from '@nix/web-workspaces/workspaces/workspace-context';
import { AttachmentsPage } from './attachments-page';

export default { title: 'Nix/Pages/Attachments', parameters: { layout: 'fullscreen' } };

const WORKSPACE = 'd5555555-5555-4555-8555-555555555555';
const FILE = 'f1111111-1111-4111-8111-111111111111';
const VERSION = 'f2222222-2222-4222-8222-222222222222';
const PRINCIPAL = 'f6666666-6666-4666-8666-666666666666';
const noop = (): void => undefined;

type Mode = 'rows' | 'empty' | 'error' | 'linksOff';

const workspace: Workspace = {
  id: WORKSPACE,
  name: 'Shared research',
  versionRetentionDays: 90,
  storageQuotaBytes: 5368709120,
  createdAt: '2026-01-01T00:00:00Z',
  kind: 'shared',
  canRename: true,
  canManageMembers: true,
  canLeave: true,
  canUseDailyNotes: true,
  pendingInvitationId: null,
  lifecycleState: 'active',
  archivedAt: null,
  membershipLocked: false,
  collaboration: true,
};

function row(title: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    itemId: FILE,
    title,
    mediaType: 'application/pdf',
    shownVersionId: VERSION,
    shownVersionState: 'draft',
    expiresAt: null,
    sourceItemId: null,
    pinCount: 0,
    hasPublicLink: false,
    ...overrides,
  };
}

const ROWS = [
  row('Contract.pdf', { pinCount: 2 }),
  row('Quarterly report.docx', { shownVersionState: 'approved', hasPublicLink: true }),
  row('Draft logo.png', { shownVersionState: 'in_review', expiresAt: '2026-12-01T00:00:00Z' }),
  row('Old terms.pdf', { shownVersionState: 'revoked' }),
];

function problem(status: number, title: string): Response {
  return Response.json({ type: 'about:blank', title, status, detail: title }, { status });
}

function clientFor(mode: Mode): NixClient {
  return createNixClient({
    baseUrl: 'http://nix.invalid',
    cache: { staleAfterMs: 0 },
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
    fetch: (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path.endsWith('/attachments')) {
        if (mode === 'error') return Promise.resolve(problem(500, 'Attachments are unavailable.'));
        const items = mode === 'empty' ? [] : mode === 'linksOff' ? ROWS.slice(0, 1) : ROWS;
        return Promise.resolve(Response.json({ items, nextCursor: null }));
      }
      if (path.endsWith('/public-link')) {
        return Promise.resolve(
          mode === 'linksOff'
            ? problem(404, 'Public links are off.')
            : Response.json({
                url: 'https://example.test/links/abc',
                itemId: FILE,
                versionId: VERSION,
                versionState: 'approved',
                createdBy: PRINCIPAL,
                createdAt: '2026-11-01T00:00:00+00:00',
                withheldFiles: [],
              }),
        );
      }
      return Promise.resolve(Response.json({ items: [], nextCursor: null }));
    },
  });
}

/** Presses the named buttons in turn as they appear, so a story can show a state behind a click. */
function useClicks(names: readonly string[]): React.RefObject<HTMLDivElement | null> {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let next = 0;
    const timer = setInterval(() => {
      const name = names[next];
      if (name === undefined) {
        clearInterval(timer);
        return;
      }
      const button = [...(root.current?.querySelectorAll('button') ?? [])].find(
        (candidate) =>
          candidate.textContent === name || candidate.getAttribute('aria-label') === name,
      );
      if (button !== undefined) {
        button.click();
        next += 1;
      }
    }, 100);
    return () => {
      clearInterval(timer);
    };
  }, [names]);
  return root;
}

const OFF_CLICKS = ['Manage Contract.pdf', 'Create public link'];

function Example({ mode }: { readonly mode: Mode }): ReactNode {
  const client = useMemo(() => clientFor(mode), [mode]);
  const root = useClicks(mode === 'linksOff' ? OFF_CLICKS : []);
  return (
    <ApiClientOverrideProvider client={client}>
      <MemoryRouter initialEntries={[`/w/${WORKSPACE}/attachments`]}>
        <Routes>
          <Route
            path="/w/:workspaceId/*"
            element={
              <WorkspaceProvider
                state={{
                  status: 'ready',
                  workspaces: [workspace],
                  error: null,
                  reload: noop,
                  workspaceCreated: noop,
                  workspaceUpdated: noop,
                  workspaceRemoved: noop,
                }}
              >
                <div ref={root} className="flex h-dvh flex-col">
                  <AttachmentsPage />
                </div>
              </WorkspaceProvider>
            }
          />
        </Routes>
      </MemoryRouter>
    </ApiClientOverrideProvider>
  );
}

export const Rows = { render: (): ReactNode => <Example mode="rows" /> };
export const Empty = { render: (): ReactNode => <Example mode="empty" /> };
export const LoadError = { render: (): ReactNode => <Example mode="error" /> };
export const PublicLinksOff = { render: (): ReactNode => <Example mode="linksOff" /> };
export const DarkRows = { ...Rows, globals: { ground: 'dark' } };
