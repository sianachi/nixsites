import { linear, NixApiError, type NixClient } from '@nix/api-client';
import { Button, Text } from '@nix/ui';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { SettingsSection } from '@nix/web-settings/settings/shared/settings-section';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { useEffect, useState, type ReactElement } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { PetConnectionsSection } from './pet-connections-section';

type ConnectionState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly connected: boolean }
  | { readonly status: 'unavailable' }
  | { readonly status: 'error' };

function returnNotice(status: string | null): string | null {
  switch (status) {
    case 'cancelled':
      return 'Linear sign-in was cancelled.';
    case 'failed':
      return 'Linear could not be connected. Try again.';
    default:
      return null;
  }
}

export function LinearConnectionsSection(): ReactElement {
  const client = useApiClient();
  const { workspaceId } = useWorkspace();
  const { pathname } = useLocation();
  const [search, setSearch] = useSearchParams();
  const returnStatus = search.get('linear_status');
  const [notice] = useState(() => returnNotice(returnStatus));

  useEffect(() => {
    if (returnStatus === null) return;
    setSearch(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('linear_status');
        return next;
      },
      { replace: true },
    );
  }, [returnStatus, setSearch]);

  return (
    <SettingsSection title="Connections">
      {notice === null ? null : (
        <Text variant="note" role="status">
          {notice}
        </Text>
      )}
      <LinearConnection
        key={workspaceId}
        client={client}
        workspaceId={workspaceId}
        returnTo={`${pathname}?tab=connections`}
      />
      <PetConnectionsSection
        key={`pet:${workspaceId}`}
        workspaceId={workspaceId}
        returnTo={`${pathname}?tab=connections`}
      />
    </SettingsSection>
  );
}

function LinearConnection({
  client,
  workspaceId,
  returnTo,
}: {
  readonly client: NixClient;
  readonly workspaceId: string;
  readonly returnTo: string;
}) {
  const [state, setState] = useState<ConnectionState>({ status: 'loading' });
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const connection = await client.query(linear.getConnection(workspaceId), {
          signal: controller.signal,
          forceRefresh: true,
        });
        if (!controller.signal.aborted)
          setState({ status: 'ready', connected: connection.connected });
      } catch (error) {
        if (controller.signal.aborted) return;
        const unavailable =
          error instanceof NixApiError &&
          (error.status === 403 || error.code === 'linear.not_found');
        setState({
          status: unavailable ? 'unavailable' : 'error',
        });
      }
    })();
    return () => {
      controller.abort();
    };
  }, [client, reload, workspaceId]);

  async function change(connected: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      if (connected) {
        await client.execute(linear.disconnect(workspaceId));
        setState({ status: 'loading' });
        setReload((current) => current + 1);
      } else {
        const { authorizationUrl } = await client.execute(linear.authorize(workspaceId, returnTo));
        window.location.assign(authorizationUrl);
        return;
      }
    } catch {
      setError(
        connected
          ? 'Linear could not be disconnected. Try again.'
          : 'Linear sign-in could not be started. Try again.',
      );
    }
    setBusy(false);
  }

  const connected = state.status === 'ready' && state.connected;
  const actionLabel = busy
    ? connected
      ? 'Disconnecting…'
      : 'Opening Linear…'
    : connected
      ? 'Disconnect'
      : 'Connect Linear';

  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-t border-divider pt-3">
      <div className="min-w-0 space-y-1">
        <Text variant="h4" as="h3">
          Linear
        </Text>
        <Text variant="note" tone="muted">
          Read-only issue lookups. Each lookup needs approval on its task.
        </Text>
        {state.status === 'loading' ? (
          <Text variant="note" role="status">
            Checking connection…
          </Text>
        ) : state.status === 'error' ? (
          <Text variant="note" role="alert">
            Could not check the Linear connection.
          </Text>
        ) : state.status === 'unavailable' ? (
          <Text variant="note" tone="muted">
            Ask a workspace owner to manage this connection.
          </Text>
        ) : (
          <Text variant="note" role="status">
            {connected ? 'Connected' : 'Not connected'}
          </Text>
        )}
        {error === null ? null : (
          <Text variant="note" role="alert">
            {error}
          </Text>
        )}
      </div>
      {state.status === 'error' ? (
        <Button
          variant="secondary"
          onClick={() => {
            setState({ status: 'loading' });
            setReload((current) => current + 1);
          }}
        >
          Retry
        </Button>
      ) : state.status === 'ready' ? (
        <Button
          variant={connected ? 'secondary' : 'primary'}
          disabled={busy}
          onClick={() => void change(connected)}
        >
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}
