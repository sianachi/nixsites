import { isNixApiError, linear, type LinearLinkResponse, type NixClient } from '@nix/api-client';
import { Button, Field, Input, Select, Text } from '@nix/ui';
import { useEffect, useState, type ReactElement } from 'react';

type Work = 'link' | 'refresh' | 'copy' | 'unlink';

export function LinearLinkSection({
  client,
  itemId,
}: {
  readonly client: NixClient;
  readonly itemId: string;
}): ReactElement | null {
  const [data, setData] = useState<LinearLinkResponse | null>(null);
  const [issue, setIssue] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [busy, setBusy] = useState<Work | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void client
      .query(linear.getLink(itemId), { signal: controller.signal, forceRefresh: true })
      .then((response) => {
        if (!controller.signal.aborted) setData(response);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (!isNixApiError(error) || (error.status !== 403 && error.status !== 404)) {
          setFailure('Could not load the linked Linear issue.');
        }
      });
    return () => {
      controller.abort();
    };
  }, [client, itemId]);

  async function run(kind: Work, operation: () => Promise<LinearLinkResponse>): Promise<void> {
    setBusy(kind);
    setFailure(null);
    try {
      setData(await operation());
    } catch (error) {
      setFailure(isNixApiError(error) ? error.message : 'Could not change the Linear link.');
    } finally {
      setBusy(null);
    }
  }

  const link = data?.link ?? null;
  const connections = data?.connections ?? [];
  const selected =
    connections.find((connection) => connection.id === connectionId) ?? connections[0];
  if (link === null && selected === undefined && failure === null) return null;

  return (
    <section aria-label="Linked Linear issue" className="flex min-w-0 flex-col gap-2">
      <Text variant="h5" as="h3">
        Linked Linear issue
      </Text>
      {failure === null ? null : (
        <Text variant="note" role="alert">
          {failure}
        </Text>
      )}
      {link === null && selected !== undefined ? (
        <form
          className="flex min-w-0 flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run('link', () =>
              client.execute(linear.linkIssue(itemId, selected.id, issue.trim())),
            );
          }}
        >
          {connections.length > 1 ? (
            <Field label="Authorized Linear team">
              {(props) => (
                <Select
                  {...props}
                  value={selected.id}
                  onChange={(event) => {
                    setConnectionId(event.target.value);
                  }}
                >
                  {connections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.teamId}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
          <Field label="Linear issue link or ID">
            {(props) => (
              <Input
                {...props}
                value={issue}
                maxLength={2048}
                onChange={(event) => {
                  setIssue(event.target.value);
                }}
              />
            )}
          </Field>
          <div>
            <Button type="submit" disabled={busy !== null || issue.trim() === ''}>
              {busy === 'link' ? 'Linking…' : 'Link Linear issue'}
            </Button>
          </div>
        </form>
      ) : null}
      {link === null ? null : (
        <>
          {link.connected && link.url !== null && link.identifier !== null ? (
            <Text variant="body" className="break-words">
              <a className="underline" href={link.url} target="_blank" rel="noreferrer">
                {link.identifier}
              </a>
            </Text>
          ) : (
            <Text variant="note">
              The Linear connection changed. Unlink the issue to choose a new connection.
            </Text>
          )}
          {link.remoteStatus === null ? null : (
            <Text variant="note" role="status">
              Linear status {link.remoteStatus}
              {link.checkedAt === null ? null : (
                <>
                  {' '}
                  · Checked{' '}
                  <time dateTime={link.checkedAt}>{new Date(link.checkedAt).toLocaleString()}</time>
                </>
              )}
            </Text>
          )}
          {link.change === 'conflict' ? (
            <Text variant="note" role="alert">
              Both statuses changed. Nix has {link.localStatus ?? 'no status'} and Linear has{' '}
              {link.remoteStatus}. Review both before editing either.
            </Text>
          ) : null}
          {link.change === 'local' ? (
            <Text variant="note">
              Nix status {link.localStatus ?? 'cleared'}. The Linear link keeps your Nix edit.
            </Text>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {link.connected ? (
              <Button
                variant="secondary"
                disabled={busy !== null}
                onClick={() =>
                  void run('refresh', () => client.execute(linear.refreshLink(itemId)))
                }
              >
                {busy === 'refresh' ? 'Refreshing…' : 'Refresh Linear status'}
              </Button>
            ) : null}
            {link.canCopyStatus && link.remoteStatus !== null ? (
              <Button
                variant="secondary"
                disabled={busy !== null}
                onClick={() =>
                  void run('copy', () =>
                    client.execute(
                      linear.copyLinkedStatus(itemId, link.revision, link.localStatus),
                    ),
                  )
                }
              >
                {busy === 'copy'
                  ? 'Copying…'
                  : link.localStatus === link.remoteStatus
                    ? 'Confirm matching status'
                    : `Copy “${link.remoteStatus}” to Nix status`}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              disabled={busy !== null}
              onClick={() =>
                void run('unlink', async () => {
                  await client.execute(linear.unlinkIssue(itemId, link.revision));
                  return { link: null, connections };
                })
              }
            >
              {busy === 'unlink' ? 'Unlinking…' : 'Unlink'}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
