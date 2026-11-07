import {
  attachments as attachmentsApi,
  isCanceledError,
  isNixApiError,
  type PublicLink,
} from '@nix/api-client';
import { Button, Dialog, Input, Text } from '@nix/ui';
import { useEffect, useState, type ReactNode } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { LoadingPanel } from '@nix/web-foundation/components/states/status-panels';

type Phase = 'loading' | 'none' | 'link' | 'confirmRevoke';

/**
 * A note's public link: what sharing means, then create; once it exists, the address, any linked
 * files the link withholds, and a revoke that confirms in place. Files keep their own control on
 * the Attachments page.
 */
export function SharePublicLinkDialog({
  itemId,
  title,
  onClose,
}: {
  readonly itemId: string;
  readonly title: string;
  readonly onClose: () => void;
}): ReactNode {
  const client = useApiClient();
  const [phase, setPhase] = useState<Phase>('loading');
  const [link, setLink] = useState<PublicLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    client
      .query(attachmentsApi.getPublicLink(itemId), {
        signal: controller.signal,
        forceRefresh: true,
      })
      .then(
        (found) => {
          setLink(found);
          setPhase('link');
        },
        (reason: unknown) => {
          if (isCanceledError(reason)) return;
          // 404 is "no link yet"; anything else is a failure worth saying.
          if (!isNixApiError(reason) || reason.status !== 404) {
            setMessage('The public link could not be loaded.');
          }
          setPhase('none');
        },
      );
    return () => {
      controller.abort();
    };
  }, [client, itemId]);

  async function create(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      setLink(await client.execute(attachmentsApi.createPublicLink(itemId)));
      setPhase('link');
    } catch (reason) {
      setMessage(
        isNixApiError(reason) && reason.detail
          ? reason.detail
          : 'The public link could not be created.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function revoke(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      await client.execute(attachmentsApi.revokePublicLink(itemId));
      setLink(null);
      setCopied(false);
      setPhase('none');
    } catch (reason) {
      setMessage(
        isNixApiError(reason) && reason.detail
          ? reason.detail
          : 'The public link could not be revoked.',
      );
      setPhase('link');
    } finally {
      setBusy(false);
    }
  }

  async function copy(): Promise<void> {
    if (link === null) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      setMessage('The link could not be copied. Select it and copy it by hand.');
    }
  }

  const actions =
    phase === 'none' ? (
      <>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            void create();
          }}
        >
          Create public link
        </Button>
      </>
    ) : phase === 'link' ? (
      <>
        <Button
          variant="danger"
          disabled={busy}
          onClick={() => {
            setPhase('confirmRevoke');
          }}
        >
          Revoke public link
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      </>
    ) : phase === 'confirmRevoke' ? (
      <>
        <Button
          variant="secondary"
          onClick={() => {
            setPhase('link');
          }}
        >
          Keep link
        </Button>
        <Button
          variant="danger"
          disabled={busy}
          onClick={() => {
            void revoke();
          }}
        >
          Revoke link
        </Button>
      </>
    ) : undefined;

  return (
    <Dialog open title={`Share “${title}”`} onClose={onClose} actions={actions}>
      <div className="flex flex-col gap-3">
        {phase === 'loading' ? <LoadingPanel label="public link" /> : null}
        {phase === 'none' ? (
          <Text variant="bodySmall">
            Anyone with the link can read this note, without signing in. It updates as you edit.
            Comments, properties and child items stay private. Attached files show only when an
            approved version exists.
          </Text>
        ) : null}
        {phase === 'confirmRevoke' ? (
          <Text variant="bodySmall">
            Anyone holding the link loses access within a minute. You can create a new link later.
          </Text>
        ) : null}
        {phase === 'link' && link !== null ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                readOnly
                aria-label="Public link"
                value={link.url}
                className="min-w-0 flex-1"
              />
              <Button
                variant="secondary"
                onClick={() => {
                  void copy();
                }}
              >
                {copied ? 'Copied' : 'Copy link'}
              </Button>
            </div>
            {link.withheldFiles.length === 0 ? null : (
              <div className="flex flex-col gap-1">
                <Text variant="note" as="h3">
                  Not shown, no approved version
                </Text>
                <ul aria-label="Files not shown" className="flex flex-col gap-1">
                  {link.withheldFiles.map((file) => (
                    <li key={file.fileItemId}>
                      <Text variant="note" as="span">
                        {file.name}
                      </Text>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : null}
        {message === null ? null : (
          <Text variant="note" as="p" role="alert">
            {message}
          </Text>
        )}
      </div>
    </Dialog>
  );
}
