import { isCanceledError, pets, type PetConnection } from '@nix/api-client';
import { Button, Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useApiClient } from '../api/api-client-provider';
import { isAborted } from '@nix/web-foundation/lib/guards';
import { useChangeFocus } from './use-change-focus';

export function PetConnectionPanel({
  compact = false,
  collapsible = false,
}: {
  readonly compact?: boolean;
  /** Shows a one-line "Connected · Change" status while connected, until Change is pressed. */
  readonly collapsible?: boolean;
}): ReactElement {
  const client = useApiClient();
  const [connection, setConnection] = useState<PetConnection | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const { panel, change: changeButton } = useChangeFocus(editing);
  const lifetime = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await client.query(pets.connection(), {
          signal: controller.signal,
          forceRefresh: true,
        });
        if (!isAborted(controller.signal)) setConnection(result);
      } catch (cause) {
        if (!isCanceledError(cause) && !isAborted(controller.signal))
          setError('ChatGPT status could not be loaded. Try again.');
      }
      if (!isAborted(controller.signal))
        timer = setTimeout(() => {
          void poll();
        }, 5000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client]);

  async function change(operation: 'connect' | 'disconnect' | 'status') {
    const controller = lifetime.current;
    if (busy || !controller || isAborted(controller.signal)) return;
    setBusy(true);
    setError('');
    try {
      const result = await client.execute(pets.runtime({ operation }), {
        signal: controller.signal,
      });
      if (!isAborted(controller.signal)) setConnection(result);
    } catch (cause) {
      if (!isCanceledError(cause) && !isAborted(controller.signal))
        setError(
          'The connection request failed. Check the worker, or enable device-code login in ChatGPT, and retry.',
        );
    } finally {
      if (!isAborted(controller.signal)) setBusy(false);
    }
  }

  if (collapsible && !editing && !error && (!connection || connection.status === 'connected')) {
    return !connection ? (
      <Text variant="note" tone="muted" role="status">
        Checking your connection…
      </Text>
    ) : (
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Text as="span" variant="note" tone="muted">
          ✓ Connected
        </Text>
        <Button
          ref={changeButton}
          aria-label="Change ChatGPT connection"
          variant="ghost"
          onClick={() => {
            setEditing(true);
          }}
        >
          Change
        </Button>
      </div>
    );
  }

  return (
    <section
      ref={panel}
      tabIndex={-1}
      aria-label="ChatGPT connection"
      className="flex w-full min-w-0 flex-col gap-3 border border-divider p-3 wrap-anywhere"
    >
      {!compact ? (
        <Text variant="h5" as="h3">
          ChatGPT connection
        </Text>
      ) : null}
      <Text variant="note" tone="muted">
        {connection?.reason ?? 'Checking your connection…'}
      </Text>
      {!compact ? (
        <details>
          <summary className="min-h-11 cursor-pointer text-sm text-accent-text">
            More<span className="sr-only"> about the ChatGPT connection</span>
          </summary>
          <Text variant="note" tone="muted">
            Connecting stores credentials privately on this Nix server. Only messages and context
            you explicitly share or approve through workspace tools are sent to ChatGPT.
          </Text>
        </details>
      ) : null}
      {connection?.status === 'connecting' && connection.verificationUrl ? (
        <>
          <Text>
            Sign-in code: <strong>{connection.userCode}</strong>
          </Text>
          <a
            href={connection.verificationUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Open ChatGPT sign-in
          </a>
        </>
      ) : null}
      {error ? <Text role="alert">{error}</Text> : null}
      <div className="flex flex-wrap gap-2">
        {connection?.status === 'connected' || connection?.status === 'connecting' ? (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              void change('disconnect');
            }}
          >
            {connection.status === 'connecting' ? 'Cancel sign-in' : 'Disconnect ChatGPT'}
          </Button>
        ) : (
          <Button
            variant="secondary"
            disabled={busy || !connection?.canConnect}
            onClick={() => {
              void change('connect');
            }}
          >
            {busy ? 'Connecting…' : 'Connect ChatGPT'}
          </Button>
        )}
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            void change('status');
          }}
        >
          Refresh connection
        </Button>
        {collapsible && connection?.status === 'connected' ? (
          <Button
            variant="ghost"
            onClick={() => {
              setEditing(false);
            }}
          >
            Done
          </Button>
        ) : null}
      </div>
    </section>
  );
}
