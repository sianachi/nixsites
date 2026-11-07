import { createNixClient } from '@nix/api-client';
import { useMemo, type ReactNode } from 'react';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { SharePublicLinkDialog } from './share-public-link-dialog';

export default { title: 'Nix/Items/Share public link', parameters: { layout: 'padded' } };

const NOTE = 'a1111111-1111-4111-8111-a1111111a111';
const FILE = 'f1111111-1111-4111-8111-111111111111';
const PRINCIPAL = 'f6666666-6666-4666-8666-666666666666';

type Mode = 'none' | 'link' | 'withheld';

function clientFor(mode: Mode) {
  return createNixClient({
    baseUrl: 'http://nix.invalid',
    cache: { staleAfterMs: 0 },
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
    fetch: () =>
      Promise.resolve(
        mode === 'none'
          ? Response.json(
              { type: 'about:blank', title: 'None', status: 404, code: 'public_links.not_found' },
              { status: 404, headers: { 'content-type': 'application/problem+json' } },
            )
          : Response.json({
              url: 'https://example.test/public/abc',
              itemId: NOTE,
              versionId: null,
              versionState: null,
              createdBy: PRINCIPAL,
              createdAt: '2026-11-01T00:00:00+00:00',
              withheldFiles:
                mode === 'withheld' ? [{ fileItemId: FILE, name: 'Contract.pdf' }] : [],
            }),
      ),
  });
}

function Example({ mode }: { readonly mode: Mode }): ReactNode {
  const client = useMemo(() => clientFor(mode), [mode]);
  return (
    <ApiClientOverrideProvider client={client}>
      <SharePublicLinkDialog itemId={NOTE} title="Project plan" onClose={() => undefined} />
    </ApiClientOverrideProvider>
  );
}

export const NoLinkYet = { render: (): ReactNode => <Example mode="none" /> };
export const LinkCreated = { render: (): ReactNode => <Example mode="link" /> };
export const WithheldFiles = { render: (): ReactNode => <Example mode="withheld" /> };
export const DarkLinkCreated = { ...LinkCreated, globals: { ground: 'dark' } };
