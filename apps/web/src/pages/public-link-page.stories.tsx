import { createNixClient, type NixClient } from '@nix/api-client';
import { useMemo, type ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { PublicLinkPage } from './public-link-page';

export default { title: 'Nix/Pages/Public link', parameters: { layout: 'fullscreen' } };

type Kind = 'note' | 'file' | 'dead';

const NOTE_HTML =
  '<h2>Plan</h2><p>Read the <a href="https://example.test/spec">spec</a> before the review.</p>' +
  '<ul><li>Draft the outline</li><li>Collect feedback</li></ul>';

function body(kind: Kind): Response {
  if (kind === 'dead') {
    return Response.json(
      { type: 'about:blank', title: 'Not found', status: 404, detail: 'Not found' },
      { status: 404 },
    );
  }
  return Response.json(
    kind === 'note'
      ? { kind: 'note', title: 'Project plan', html: NOTE_HTML }
      : {
          kind: 'file',
          name: 'Quarterly report.zip',
          mediaType: 'application/zip',
          url: 'https://files.example.test/report.zip',
        },
  );
}

function clientFor(kind: Kind): NixClient {
  return createNixClient({
    baseUrl: 'http://nix.invalid',
    cache: { staleAfterMs: 0 },
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
    fetch: () => Promise.resolve(body(kind)),
  });
}

function Example({ kind }: { readonly kind: Kind }): ReactNode {
  const client = useMemo(() => clientFor(kind), [kind]);
  return (
    <ApiClientOverrideProvider client={client}>
      <MemoryRouter initialEntries={['/links/story-token']}>
        <Routes>
          <Route path="/links/:token" element={<PublicLinkPage />} />
        </Routes>
      </MemoryRouter>
    </ApiClientOverrideProvider>
  );
}

export const Note = { render: (): ReactNode => <Example kind="note" /> };
export const File = { render: (): ReactNode => <Example kind="file" /> };
export const DeadLink = { render: (): ReactNode => <Example kind="dead" /> };
export const DarkNote = { ...Note, globals: { ground: 'dark' } };
