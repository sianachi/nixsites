import {
  isNixApiError,
  petPeers,
  type NixClient,
  type PetPeer,
  type PetPeerKind,
  type PetPeerRegistration,
  type PetPeerWork,
} from '@nix/api-client';
import { Button, Field, Input, Select, Text } from '@nix/ui';
import { useOptionalApiClient } from '@nix/web-platform/api/api-client-provider';
import { useEffect, useRef, useState, type ReactElement } from 'react';

const labels = {
  client: 'MCP client',
  claude: 'Claude Code runner',
  codex: 'Codex runner',
} as const;
const statusLabels = {
  submitted: 'Submitted',
  queued: 'Awaiting runner',
  running: 'Working',
  completed: 'Complete',
  failed: 'Failed',
  review_required: 'Needs review',
} as const;

export function PetPeerSection({
  itemId,
  workEnabled = true,
}: {
  readonly itemId: string;
  readonly workEnabled?: boolean;
}): ReactElement | null {
  const client = useOptionalApiClient();
  return client === null ? null : (
    <Peers key={itemId} itemId={itemId} client={client} workEnabled={workEnabled} />
  );
}

function Peers({
  itemId,
  client,
  workEnabled,
}: {
  readonly itemId: string;
  readonly client: NixClient;
  readonly workEnabled: boolean;
}): ReactElement | null {
  const [peers, setPeers] = useState<readonly PetPeer[] | null>(null);
  const [work, setWork] = useState<readonly PetPeerWork[]>([]);
  const [canUseWork, setCanUseWork] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<PetPeerKind>('client');
  const [created, setCreated] = useState<PetPeerRegistration | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loadedAt, setLoadedAt] = useState(0);
  const nameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      try {
        const request = { signal: controller.signal, forceRefresh: true };
        const [list, pending] = await Promise.all([
          client.query(petPeers.list(itemId), request),
          workEnabled
            ? client.query(petPeers.listWork(itemId), request).catch((failure: unknown) => {
                if (unavailable(failure)) return null;
                throw failure;
              })
            : null,
        ]);
        if (controller.signal.aborted) return;
        setPeers(list.peers);
        setWork(pending?.work ?? []);
        setCanUseWork(pending !== null);
        if (pending === null) setCreated(null);
        setLoadedAt(Date.now());
        if (workEnabled) {
          timer = setTimeout(() => {
            void read();
          }, 5000);
        }
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (unavailable(failure)) {
          setPeers(null);
          setWork([]);
          setCanUseWork(false);
          setCreated(null);
          return;
        }
        setError('Could not load task peers.');
      }
    }
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, itemId, refresh, workEnabled]);

  const canRegister = workEnabled && canUseWork;
  async function register() {
    if (!canRegister || name.trim() === '') return;
    setBusy(true);
    setError('');
    try {
      const result = await client.execute(petPeers.register(itemId, name.trim(), kind));
      setCreated(result);
      setName('');
      setRefresh((current) => current + 1);
      nameInput.current?.focus();
    } catch {
      setError('Could not register this peer.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(peerId: string) {
    setBusy(true);
    setError('');
    try {
      await client.execute(petPeers.revoke(itemId, peerId));
      if (created?.peer.id === peerId) setCreated(null);
      setRefresh((current) => current + 1);
      nameInput.current?.focus();
    } catch {
      setError('Could not revoke this peer.');
    } finally {
      setBusy(false);
    }
  }

  if (peers === null && error === '') return null;
  if (!canRegister && peers?.length === 0) return null;

  return (
    <section aria-label="Task peers" className="flex min-w-0 flex-col gap-2">
      <Text as="h3" variant="h5">
        Task peers
      </Text>
      {error ? (
        <Text variant="note" role="alert">
          {error}
        </Text>
      ) : null}
      {canRegister ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void register();
          }}
        >
          <Field label="Peer name" required>
            {(props) => (
              <Input
                {...props}
                ref={nameInput}
                value={name}
                maxLength={100}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            )}
          </Field>
          <Field label="Peer type">
            {(props) => (
              <Select
                {...props}
                value={kind}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === 'client' || value === 'claude' || value === 'codex') setKind(value);
                }}
              >
                <option value="client">{labels.client}</option>
                <option value="claude">{labels.claude}</option>
                <option value="codex">{labels.codex}</option>
              </Select>
            )}
          </Field>
          <Button type="submit" disabled={busy || name.trim() === ''}>
            Register peer
          </Button>
        </form>
      ) : null}
      {!canRegister || created === null ? null : (
        <div className="flex min-w-0 flex-col gap-2 rounded-sm border border-divider p-3">
          <Text variant="note" role="status">
            Peer registered. Copy its credential now.
          </Text>
          <Field label="Pet MCP address">
            {(props) => (
              <Input
                {...props}
                value={created.endpoint}
                readOnly
                onFocus={(event) => {
                  event.target.select();
                }}
              />
            )}
          </Field>
          <Field label="Peer bearer credential">
            {(props) => (
              <Input
                {...props}
                value={created.credential}
                readOnly
                onFocus={(event) => {
                  event.target.select();
                }}
              />
            )}
          </Field>
          <Button
            variant="secondary"
            onClick={() => {
              setCreated(null);
            }}
          >
            Hide credential
          </Button>
        </div>
      )}
      {peers?.length ? (
        <ul className="flex flex-col gap-2">
          {peers.map((peer) => (
            <li key={peer.id} className="flex min-w-0 items-center justify-between gap-2">
              <div className="min-w-0">
                <Text variant="bodySmall" className="wrap-anywhere">
                  {peer.name}
                </Text>
                <Text variant="note" tone="muted">
                  {peer.revokedAt
                    ? 'Revoked'
                    : Date.parse(peer.expiresAt) <= loadedAt
                      ? 'Expired'
                      : labels[peer.kind]}
                </Text>
              </div>
              {peer.revokedAt || Date.parse(peer.expiresAt) <= loadedAt ? null : (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void revoke(peer.id)}
                  aria-label={`Revoke ${peer.name}`}
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {canRegister && work.length ? (
        <ul className="flex flex-col gap-2" aria-label="Peer work">
          {work.map((entry) => (
            <li key={entry.id} className="rounded-sm border border-divider p-3">
              <Text variant="bodySmall">
                {peers?.find((peer) => peer.id === entry.peerId)?.name ?? 'Registered peer'} ·{' '}
                {statusLabels[entry.status]}
              </Text>
              {entry.result ? (
                <Text variant="note" className="whitespace-pre-wrap wrap-anywhere">
                  {entry.result}
                </Text>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function unavailable(failure: unknown): boolean {
  return isNixApiError(failure) && (failure.status === 403 || failure.status === 404);
}
