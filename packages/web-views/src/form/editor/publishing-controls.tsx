import { Button, Dialog, Input, Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { isCanceledError, isNixApiError } from '@nix/api-client';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { changePublicFormStatus, publicFormStatus } from '../public-form-api';

export function PublishingControls({
  itemId,
  viewId,
}: {
  readonly itemId: string | null;
  readonly viewId: string;
}): ReactNode {
  const client = useApiClient();
  const [url, setUrl] = useState<string | null>(null);
  const [published, setPublished] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    itemId === null ? 'idle' : 'loading',
  );
  const [working, setWorking] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const pendingChange = useRef<AbortController | null>(null);

  useEffect(() => {
    if (itemId === null) return;
    const controller = new AbortController();
    void client
      .query(publicFormStatus(itemId, viewId), {
        signal: controller.signal,
        forceRefresh: true,
      })
      .then((result) => {
        setPublished(result.published);
        setUrl(result.url);
        setStatus('ready');
      })
      .catch((reason: unknown) => {
        if (isCanceledError(reason)) return;
        setStatus('error');
        setOutcome(formLinkFailure(reason, 'The public-link status could not be loaded.'));
      });
    return () => {
      controller.abort();
      pendingChange.current?.abort();
    };
  }, [client, itemId, viewId]);

  async function change(method: 'PUT' | 'DELETE'): Promise<void> {
    if (itemId === null || status !== 'ready') return;
    pendingChange.current?.abort();
    const controller = new AbortController();
    pendingChange.current = controller;
    setWorking(true);
    setOutcome(null);
    try {
      const result = await client.execute(changePublicFormStatus(itemId, viewId, method), {
        signal: controller.signal,
      });
      setPublished(result.published);
      setUrl(result.url);
      setOutcome(
        result.published ? 'A new public link is ready.' : 'The public link has been revoked.',
      );
    } catch (reason) {
      if (isCanceledError(reason)) return;
      setOutcome(
        formLinkFailure(
          reason,
          'The public link could not be changed. Save this view and try again.',
        ),
      );
    } finally {
      if (pendingChange.current === controller) pendingChange.current = null;
      setWorking(false);
    }
  }

  async function copyLink(): Promise<void> {
    if (url === null) return;
    try {
      await navigator.clipboard.writeText(url);
      setOutcome('Public form link copied.');
    } catch {
      setOutcome('The link could not be copied. Select and copy it from the field.');
    }
  }

  return (
    <section className="flex min-w-0 flex-col gap-2 border-t border-divider p-3">
      <div>
        <Text variant="h4" as="h3" className="wrap-anywhere">
          Publish
        </Text>
        <Text variant="note" tone="muted">
          Save form changes first. Republishing rotates the old link.
        </Text>
        <Text variant="note" tone="muted">
          Status:{' '}
          {status === 'loading'
            ? 'Checking publication status'
            : status === 'error'
              ? 'Unavailable'
              : status === 'idle'
                ? 'Save this view to check'
                : published
                  ? 'Published'
                  : 'Not published'}
        </Text>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={working || itemId === null || status !== 'ready'}
          onClick={() => {
            void change('PUT');
          }}
        >
          {working ? 'Working…' : published ? 'Publish new link' : 'Publish form'}
        </Button>
        <Button
          variant="secondary"
          disabled={working || itemId === null || status !== 'ready' || !published}
          onClick={() => {
            setRevoking(true);
          }}
        >
          Revoke link
        </Button>
      </div>
      {url === null ? null : (
        <div className="flex min-w-0 flex-wrap gap-2">
          <Input aria-label="Public form URL" className="min-w-0 flex-1" readOnly value={url} />
          <Button
            variant="secondary"
            onClick={() => {
              void copyLink();
            }}
          >
            Copy
          </Button>
        </div>
      )}
      {outcome === null ? null : (
        <Text variant="note" role="status">
          {outcome}
        </Text>
      )}
      <Dialog
        open={revoking}
        title="Revoke the public link?"
        onClose={() => {
          setRevoking(false);
        }}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setRevoking(false);
              }}
            >
              Keep link
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setRevoking(false);
                void change('DELETE');
              }}
            >
              Revoke link
            </Button>
          </>
        }
      >
        <Text variant="bodySmall">
          People with the link will no longer be able to open or submit the form. Publishing again
          creates a new link.
        </Text>
      </Dialog>
    </section>
  );
}

function formLinkFailure(reason: unknown, fallback: string): string {
  return isNixApiError(reason) ? (reason.detail ?? fallback) : fallback;
}
