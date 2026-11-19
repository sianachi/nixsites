import {
  isNixApiError,
  petConnections,
  type AuthorizePetConnection,
  type PetConnectionList,
  type PetServiceConnection,
} from '@nix/api-client';
import { Button, Checkbox, Field, Input, Select, Text } from '@nix/ui';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useEffect, useState, type ReactElement } from 'react';
import { useSearchParams } from 'react-router';
import { PetRemoteConnectionForm } from './pet-remote-connection-form';
import { PetSiteSessionForm } from './pet-site-session-form';

const providerNames = new Map([
  ['google', 'Google'],
  ['microsoft', 'Microsoft'],
  ['slack', 'Slack'],
  ['github', 'GitHub'],
  ['linear', 'Linear'],
  ['browser-site', 'Website'],
  ['mcp', 'MCP'],
]);

function providerName(provider: string): string {
  return providerNames.get(provider) ?? provider;
}

export function PetConnectionsSection({
  workspaceId,
  returnTo,
}: {
  readonly workspaceId: string;
  readonly returnTo: string;
}): ReactElement | null {
  const client = useApiClient();
  const [search, setSearch] = useSearchParams();
  const callback = search.get('pet_connection_status');
  const [returned] = useState(callback);
  const [data, setData] = useState<PetConnectionList | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => {
    setReload((value) => value + 1);
  };

  useEffect(() => {
    if (callback === null) return;
    setSearch(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('pet_connection_status');
        return next;
      },
      { replace: true },
    );
  }, [callback, setSearch]);

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
        setData(null);
        if (!isNixApiError(error) || (error.status !== 403 && error.status !== 404)) {
          setFailure('Could not load the workspace connections. Try again.');
        }
      });
    return () => {
      controller.abort();
    };
  }, [client, reload, workspaceId]);

  async function authorize(input: AuthorizePetConnection, connectionId: string): Promise<void> {
    setBusy(connectionId);
    setFailure(null);
    try {
      const result = await client.execute(
        petConnections.authorize(workspaceId, { ...input, returnTo }),
      );
      const target = new URL(result.authorizationUrl);
      if (input.calendarLinkId !== undefined) {
        const returnPath = new URL(returnTo, window.location.origin);
        if (
          target.origin !== returnPath.origin ||
          target.pathname !== returnPath.pathname ||
          target.searchParams.get('tab') !== 'connections' ||
          target.searchParams.get('pet_connection_status') !== 'connected'
        ) {
          throw new Error('Unexpected calendar setup destination');
        }
      } else if (target.protocol !== 'https:') {
        throw new Error('Unexpected OAuth destination');
      }
      window.location.assign(target);
    } catch (error) {
      setFailure(isNixApiError(error) ? error.message : 'Could not start sign-in. Try again.');
      setBusy(null);
    }
  }

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

  if (data === null || (!data.enabled && data.connections.length === 0)) {
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
    <section
      aria-label="Pet connections"
      className="flex min-w-0 flex-col gap-3 border-t border-divider pt-3"
    >
      <Text variant="h4" as="h3">
        Pet connections
      </Text>
      {returned === null ? null : (
        <Text variant="note" role="status">
          {returned === 'connected'
            ? 'Resource connected.'
            : returned === 'cancelled'
              ? 'Sign-in was cancelled.'
              : 'The resource could not be connected.'}
        </Text>
      )}
      {data.enabled ? (
        <>
          <ConnectionForm
            actions={data.actions}
            calendars={data.calendars}
            disabled={busy !== null}
            starting={busy === 'new'}
            onAuthorize={(input) => authorize(input, 'new')}
          />
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
                {providerName(connection.provider)} · {connection.resourceKind.replaceAll('_', ' ')}{' '}
                · {connection.resourceId}
              </Text>
              <Text variant="note" tone="muted" className="wrap-anywhere">
                {connection.actions
                  .map((id) => data.actions.find((action) => action.id === id)?.description ?? id)
                  .join(' · ')}
              </Text>
              {data.enabled && connection.provider === 'browser-site' ? (
                <Text variant="note" tone="muted">
                  To use this session, name the website in the job and ask your pet to use its
                  connection.
                </Text>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {data.enabled &&
                connection.provider !== 'mcp' &&
                connection.provider !== 'browser-site' ? (
                  <Button
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() => {
                      const calendar =
                        connection.resourceKind === 'calendar'
                          ? data.calendars.find(
                              ({ provider, resourceId }) =>
                                provider === connection.provider &&
                                resourceId === connection.resourceId,
                            )
                          : undefined;
                      void authorize(
                        {
                          provider: connection.provider,
                          resourceKind: connection.resourceKind,
                          resourceId: connection.resourceId,
                          actions: connection.actions,
                          ...(calendar === undefined ? {} : { calendarLinkId: calendar.linkId }),
                        },
                        connection.id,
                      );
                    }}
                  >
                    Reconnect
                  </Button>
                ) : null}
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

function ConnectionForm({
  actions,
  calendars,
  disabled,
  starting,
  onAuthorize,
}: {
  readonly actions: PetConnectionList['actions'];
  readonly calendars: PetConnectionList['calendars'];
  readonly disabled: boolean;
  readonly starting: boolean;
  readonly onAuthorize: (input: AuthorizePetConnection) => Promise<void>;
}): ReactElement {
  const providers = [
    ...new Set([
      ...actions
        .filter(({ configured, resourceKind }) => configured && resourceKind !== 'calendar')
        .map(({ provider }) => provider),
      ...calendars.map(({ provider }) => provider),
    ]),
  ];
  const [provider, setProvider] = useState('');
  const [resourceKind, setResourceKind] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [calendarId, setCalendarId] = useState('');
  const [selected, setSelected] = useState<readonly string[]>([]);
  const existingCalendars = calendars.filter(({ provider: name }) => name === provider);
  const calendar =
    resourceKind === 'calendar'
      ? existingCalendars.find(({ linkId }) => linkId === calendarId)
      : undefined;
  const providerActions = actions.filter(
    (action) =>
      action.provider === provider &&
      (action.resourceKind === 'calendar' ? existingCalendars.length > 0 : action.configured),
  );
  const resourceKinds = [...new Set(providerActions.map((action) => action.resourceKind))];
  const choices = providerActions.filter(
    (action) =>
      action.resourceKind === resourceKind &&
      (action.resourceKind !== 'calendar' ||
        (calendar !== undefined && (action.kind === 'read' || calendar.writable))),
  );
  const chosen = choices.filter(({ id }) => selected.includes(id)).map(({ id }) => id);
  const targetId = calendar?.resourceId ?? resourceId.trim();
  const canAuthorize =
    !disabled && /^[A-Za-z0-9_.@+!~:/=,%$-]{1,512}$/.test(targetId) && chosen.length > 0;
  if (providers.length === 0) {
    return (
      <Text variant="note" tone="muted">
        No providers are configured for this workspace.
      </Text>
    );
  }
  return (
    <form
      className="flex min-w-0 flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (canAuthorize) {
          void onAuthorize({
            provider,
            resourceKind,
            resourceId: targetId,
            actions: chosen,
            ...(calendar === undefined ? {} : { calendarLinkId: calendar.linkId }),
          });
        }
      }}
    >
      <Field label="Provider">
        {(control) => (
          <Select
            {...control}
            value={provider}
            disabled={disabled}
            onChange={(event) => {
              setProvider(event.target.value);
              setResourceKind('');
              setResourceId('');
              setCalendarId('');
              setSelected([]);
            }}
          >
            <option value="">Choose a provider</option>
            {providers.map((id) => (
              <option key={id} value={id}>
                {providerName(id)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {provider === '' ? null : (
        <Field label="Resource type">
          {(control) => (
            <Select
              {...control}
              value={resourceKind}
              disabled={disabled}
              onChange={(event) => {
                setResourceKind(event.target.value);
                setResourceId('');
                setCalendarId('');
                setSelected([]);
              }}
            >
              <option value="">Choose a resource type</option>
              {resourceKinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kind.replaceAll('_', ' ')}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {resourceKind === '' ? null : (
        <>
          {resourceKind === 'calendar' && existingCalendars.length > 0 ? (
            <Field label="Linked calendar" hint="Reuse an existing Nix calendar connection.">
              {(control) => (
                <Select
                  {...control}
                  value={calendarId}
                  disabled={disabled}
                  onChange={(event) => {
                    setCalendarId(event.target.value);
                    setSelected([]);
                  }}
                >
                  <option value="">Choose a linked calendar</option>
                  {existingCalendars.map(({ linkId, name }) => (
                    <option key={linkId} value={linkId}>
                      {name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
          {resourceKind !== 'calendar' ? (
            <Field label="Resource ID" hint="Use the ID of the exact resource from the provider.">
              {(control) => (
                <Input
                  {...control}
                  value={resourceId}
                  maxLength={512}
                  disabled={disabled}
                  required
                  onChange={(event) => {
                    setResourceId(event.target.value);
                  }}
                />
              )}
            </Field>
          ) : null}
          <fieldset aria-label="Allowed actions" className="flex min-w-0 flex-col gap-1">
            <Text variant="bodySmall" as="span">
              Allowed actions
            </Text>
            {choices.map((choice) => (
              <Checkbox
                key={choice.id}
                label={choice.description}
                checked={selected.includes(choice.id)}
                disabled={disabled}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setSelected((current) =>
                    checked ? [...current, choice.id] : current.filter((id) => id !== choice.id),
                  );
                }}
              />
            ))}
          </fieldset>
          <div>
            <Button type="submit" disabled={!canAuthorize}>
              {calendar === undefined
                ? starting
                  ? 'Opening provider…'
                  : 'Connect resource'
                : starting
                  ? 'Connecting calendar…'
                  : 'Connect linked calendar'}
            </Button>
          </div>
        </>
      )}
    </form>
  );
}
