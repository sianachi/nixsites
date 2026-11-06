import { createNixClient } from '@nix/api-client';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { renderAt } from '@nix/web-editor/testing/render-with-router';
import { sanitizePublicHtml } from '../../pages/public-link-html';
import { PublicLinkPage } from '../../pages/public-link-page';

const FILE = '/public/v1/links/tok%20en/files/66666666-6666-4666-8666-666666666661';

function renderLink(respond: () => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(respond())),
  );
  const client = createNixClient({
    baseUrl: 'http://localhost',
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
  });
  renderAt(
    <ApiClientOverrideProvider client={client}>
      <Routes>
        <Route path="/links/:token" element={<PublicLinkPage />} />
      </Routes>
    </ApiClientOverrideProvider>,
    '/links/tok%20en',
  );
}

describe('public link page', () => {
  it('shows a note read-only, with sanitized html and the token in file addresses', async () => {
    renderLink(() =>
      Response.json({
        kind: 'note',
        title: 'Plan',
        html: `<p>Hello <a href="${FILE}">plan.pdf</a></p><script>window.hacked = 1</script><img src="https://evil.test/x.png" onerror="alert(1)">`,
      }),
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Plan' })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'plan.pdf' });
    expect(link).toHaveAttribute(
      'href',
      '/public/v1/links/tok%20en/files/66666666-6666-4666-8666-666666666661',
    );
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.head.querySelector('meta[name="robots"]')).toHaveAttribute(
      'content',
      'noindex, nofollow',
    );
  });

  it('shows a file as a download and frames a PDF as a blob', async () => {
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => 'blob:brief'),
        revokeObjectURL: vi.fn(),
      }),
    );
    renderLink(() =>
      Response.json({
        kind: 'file',
        name: 'brief.pdf',
        mediaType: 'application/pdf',
        url: 'https://files.test/brief',
      }),
    );
    expect(await screen.findByRole('link', { name: 'Download brief.pdf' })).toHaveAttribute(
      'href',
      'https://files.test/brief',
    );
    expect(await screen.findByTitle('brief.pdf')).toHaveAttribute('src', 'blob:brief');
  });

  it('gives a dead link a plain message with no reason', async () => {
    renderLink(() => new Response(null, { status: 404 }));
    expect(await screen.findByText('This link is unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/revoked|expired|trashed/i)).toBeNull();
  });
});

describe('sanitizePublicHtml', () => {
  it.each([
    ['<a href="javascript:alert(1)">x</a>', '<a>x</a>'],
    ['<p onclick="x()">t</p>', '<p>t</p>'],
    ['<iframe src="https://a.test"></iframe><p>t</p>', '<p>t</p>'],
    ['<custom-tag>kept text</custom-tag>', 'kept text'],
    ['<img src="javascript:alert(1)" alt="a">', ''],
    ['<a href="/api/v1/items">x</a>', '<a>x</a>'],
  ])('%s', (input, expected) => {
    expect(sanitizePublicHtml(input, 'tok')).toBe(expected);
  });
});
