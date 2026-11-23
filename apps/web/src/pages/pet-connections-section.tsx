import {
  isNixApiError,
  petConnections,
  type PetConnectionList,
  type PetServiceConnection,
} from '@nix/api-client';
import { Button, Text } from '@nix/ui';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { SettingsSection } from '@nix/web-settings/settings/shared/settings-section';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { useEffect, useState, type ReactElement } from 'react';
import { PetRemoteConnectionForm } from './pet-remote-connection-form';
import { PetSiteSessionForm } from './pet-site-session-form';

export function ConnectionsSection(): ReactElement {
  const { workspaceId } = useWorkspace();
  return (
    <SettingsSection title="Connections">
      <PetConnections key={workspaceId} workspaceId={workspaceId} />
    </SettingsSection>
  );
}

function PetConnections({ workspaceId }: { readonly workspaceId: string }): ReactElement | null {
  const client = useApiClient();
  const [data, setData] = useState<PetConnectionList | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => {
    setReload((value) => value + 1);
  };

  useEffect(() => {
    const controller = new AbortController();
    void client
      .query(petConnections.list(workspaceId), {
        signal: controller.signal,
        forceRefresh: true,
      })
      .then((list) => {
        if (!controller.signal.aborted) setData(list);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (isNixApiError(error) && (error.status === 403 || error.status === 404)) {
          setData({ enabled: false, connections: [] });
        } else {
          setData(null);
          setFailure('Could not load the workspace connections. Try again.');
        }
      });
    return () => {
      controller.abort();
    };
  }, [client, reload, workspaceId]);

  async function disconnect(connection: PetServiceConnection): Promise<void> {
    setBusy(connection.id);
    setFailure(null);
    try {
      await client.execute(petConnections.disconnect(workspaceId, connection.id));
      setData((current) =>
        current === null
          ? current
          : {
              ...current,
              connections: current.connections.filter(({ id }) => id !== connection.id),
            },
      );
      setReload((value) => value + 1);
    } catch (error) {
      setFailure(
        isNixApiError(error) ? error.message : 'Could not disconnect this resource. Try again.',
      );
    } finally {
      setBusy(null);
    }
  }

  if (data !== null && !data.enabled && data.connections.length === 0) {
    return (
      <Text variant="note" tone="muted">
        Connections are not available in this workspace.
      </Text>
    );
  }
  if (data === null) {
    return failure === null ? null : (
      <div className="flex flex-col gap-2">
        <Text variant="note" role="alert">
          {failure}
        </Text>
        <div>
          <Button
            variant="secondary"
            onClick={() => {
              setFailure(null);
              setReload((value) => value + 1);
            }}
          >
            Try again
          </Button>
        </div>
      </div>
    );
  }
  return (
    <section aria-label="Pet connections" className="flex min-w-0 flex-col gap-3">
      {data.enabled ? (
        <>
          <PetRemoteConnectionForm
            workspaceId={workspaceId}
            onRegistered={refresh}
            disabled={busy !== null}
          />
          <PetSiteSessionForm
            workspaceId={workspaceId}
            onRegistered={refresh}
            disabled={busy !== null}
          />
        </>
      ) : (
        <Text variant="note" tone="muted">
          Pet connections are paused. You can still disconnect a resource.
        </Text>
      )}
      {failure === null ? null : (
        <Text variant="note" role="alert">
          {failure}
        </Text>
      )}
      {data.connections.length === 0 ? null : (
        <ul aria-label="Connected resources" className="flex flex-col gap-2">
          {data.connections.map((connection) => (
            <li
              key={connection.id}
              className="flex min-w-0 flex-col gap-2 rounded-sm border border-divider p-3"
            >
              <Text variant="bodySmall" className="wrap-anywhere">
                {connection.provider === 'mcp' ? 'MCP tool' : 'Website'} · {connection.resourceId}
              </Text>
              <Text variant="note" tone="muted" className="wrap-anywhere">
                {connection.actions.join(' · ')}
              </Text>
              {data.enabled && connection.provider === 'browser-site' ? (
                <Text variant="note" tone="muted">
                  To use this session, name the website in the job and ask your pet to use its
                  connection.
                </Text>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => void disconnect(connection)}
                >
                  Disconnect
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
