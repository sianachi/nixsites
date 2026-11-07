import { Text } from '@nix/ui';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams } from 'react-router';

import { isCanceledError } from '@nix/api-client';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { ErrorPanel, LoadingPanel } from '@nix/web-foundation/components/states/status-panels';
import { sanitizePublicHtml } from '@nix/web-foundation/lib/public-link-html';
import { publicLinkByToken, type PublicLink } from './public-link-api';

const NOTE_STYLE =
  'min-w-0 wrap-anywhere [&_p]:my-2 [&_a]:underline [&_img]:h-auto [&_img]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-divider [&_pre]:p-3 [&_table]:w-full [&_td]:border [&_td]:border-divider [&_td]:p-2 [&_th]:border [&_th]:border-divider [&_th]:p-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_h2]:mt-6 [&_h2]:text-xl [&_h3]:mt-4 [&_h3]:text-lg [&_.nix-anchor]:sr-only [&_.nix-notice]:italic';

/** A public link, read-only and without app chrome. A dead link says only that it is unavailable. */
export function PublicLinkPage(): ReactNode {
  const { token = '' } = useParams();
  const client = useApiClient();
  const [link, setLink] = useState<PublicLink | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // The token is a bearer capability: keep it out of search indexes and referrers.
    const tags = [
      ['robots', 'noindex, nofollow'],
      ['referrer', 'no-referrer'],
    ].map(([name = '', content = '']) => {
      const meta = document.createElement('meta');
      meta.name = name;
      meta.content = content;
      document.head.append(meta);
      return meta;
    });
    return () => {
      tags.forEach((meta) => {
        meta.remove();
      });
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void client
      .query(publicLinkByToken(token), { signal: controller.signal, forceRefresh: true })
      .then(setLink)
      .catch((reason: unknown) => {
        if (!isCanceledError(reason)) setFailed(true);
      });
    return () => {
      controller.abort();
    };
  }, [client, token]);

  const html = useMemo(
    () => (link?.kind === 'note' ? sanitizePublicHtml(link.html ?? '', token) : ''),
    [link, token],
  );

  return (
    <main className="mx-auto flex min-h-dvh w-full min-w-0 max-w-3xl flex-col gap-4 px-4 py-6 sm:px-6">
      {failed ? (
        <ErrorPanel title="This link is unavailable" detail="" />
      ) : link === null ? (
        <LoadingPanel label="the page" />
      ) : link.kind === 'note' ? (
        <article className="flex min-w-0 flex-col gap-3">
          <Text variant="h2" as="h1" className="wrap-anywhere">
            {link.title ?? 'Untitled'}
          </Text>
          <div className={NOTE_STYLE} dangerouslySetInnerHTML={{ __html: html }} />
        </article>
      ) : (
        <FileView link={link} />
      )}
    </main>
  );
}

function FileView({ link }: { readonly link: PublicLink }): ReactNode {
  const name = link.name ?? 'File';
  const type = link.mediaType ?? '';
  const url = link.url ?? '';
  const safe = /^https?:\/\//i.test(url) ? url : '';
  const pdf = usePdfBlob(type === 'application/pdf' ? safe : '');
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <Text variant="h2" as="h1" className="wrap-anywhere">
        {name}
      </Text>
      {safe !== '' && type.startsWith('image/') ? (
        <img src={safe} alt={name} className="h-auto max-w-full" />
      ) : null}
      {pdf !== null ? (
        <iframe
          src={pdf}
          title={name}
          className="h-[70dvh] w-full rounded-md border border-divider"
        />
      ) : null}
      {safe !== '' ? (
        <a href={safe} download={name} className="underline">
          Download {name}
        </a>
      ) : null}
    </section>
  );
}

/**
 * The page's CSP frames only itself and blobs, so a PDF is fetched and framed as a blob, the way the
 * signed-in file viewer does. A failed fetch leaves just the download link.
 */
function usePdfBlob(url: string): string | null {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  useEffect(() => {
    if (url === '') return undefined;
    const controller = new AbortController();
    let created: string | null = null;
    void fetch(url, { signal: controller.signal })
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => {
        if (blob === null) return;
        created = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
        setBlobUrl(created);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      if (created !== null) URL.revokeObjectURL(created);
      setBlobUrl(null);
    };
  }, [url]);
  return blobUrl;
}
