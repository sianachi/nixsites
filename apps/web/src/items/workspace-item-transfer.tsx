import { isCanceledError, isNixApiError, items, type Item } from '@nix/api-client';
import { Button, Field, Select, Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { useApiClient } from '../api/api-client-provider';
import { notifyItemChildrenChanged } from '@nix/web-foundation/lib/item-children-changed';

/** The destinations are supplied by Core; browser membership data never decides write access. */
export function WorkspaceItemTransfer({
  itemId,
  sourceWorkspaceId,
  onClose,
  onBusyChange,
}: {
  readonly itemId: string;
  readonly sourceWorkspaceId: string;
  readonly onClose: () => void;
  readonly onBusyChange: (busy: boolean) => void;
}): ReactNode {
  const client = useApiClient();
  const navigate = useNavigate();
  const [destinations, setDestinations] = useState<readonly items.ItemMoveWorkspace[]>([]);
  const [destinationId, setDestinationId] = useState('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'partial' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const pending = useRef(false);
  const activeMove = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const collected: items.ItemMoveWorkspace[] = [];
    void (async () => {
      try {
        for await (const destination of client.paginate(items.listItemMoveWorkspaces(itemId), {
          signal: controller.signal,
        })) {
          collected.push(destination);
        }
        if (controller.signal.aborted) return;
        setDestinations(collected);
        setStatus('ready');
      } catch (cause) {
        if (controller.signal.aborted || isCanceledError(cause)) return;
        setDestinations(collected);
        setStatus(collected.length > 0 ? 'partial' : 'error');
        setError(
          'Destination workspaces could not all be loaded. Try again to see the complete list.',
        );
      }
    })();
    return () => {
      controller.abort();
    };
  }, [client, itemId, reloadKey]);

  useEffect(() => () => activeMove.current?.abort(), []);

  async function transfer(): Promise<void> {
    if (pending.current || destinationId === '') return;
    pending.current = true;
    const controller = new AbortController();
    activeMove.current = controller;
    setSaving(true);
    onBusyChange(true);
    setError(null);
    try {
      const moved: Item = await client.execute(
        items.moveItem(sourceWorkspaceId, itemId, {
          workspaceId: destinationId,
          parentId: null,
          afterId: null,
        }),
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      notifyItemChildrenChanged(sourceWorkspaceId, null);
      notifyItemChildrenChanged(moved.workspaceId, null);
      onClose();
      void navigate(
        `/w/${encodeURIComponent(moved.workspaceId)}?item=${encodeURIComponent(moved.id)}`,
      );
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(
        isNixApiError(cause) && cause.kind === 'problem'
          ? (cause.detail ?? cause.message)
          : 'The move could not be confirmed. Check both workspaces before retrying.',
      );
    } finally {
      pending.current = false;
      activeMove.current = null;
      if (!controller.signal.aborted) {
        setSaving(false);
        onBusyChange(false);
      }
    }
  }

  return (
    <section aria-label="Move to another workspace" className="flex min-w-0 flex-col gap-3">
      <Text as="p" variant="bodySmall">
        This moves the item and all its children to the top of the selected workspace. Its members
        will have access through that workspace. Existing item grants stay with the item; published
        form links are revoked.
      </Text>
      {status === 'loading' ? (
        <Text variant="note" role="status">
          Loading workspaces…
        </Text>
      ) : null}
      {status === 'ready' && destinations.length === 0 ? (
        <Text variant="note">There are no other workspaces you can move this item into.</Text>
      ) : null}
      {destinations.length > 0 ? (
        <Field label="Destination workspace">
          {(control) => (
            <Select
              {...control}
              value={destinationId}
              disabled={saving}
              onChange={(event) => {
                setDestinationId(event.currentTarget.value);
              }}
            >
              <option value="">Choose a workspace</option>
              {destinations.map((destination) => (
                <option key={destination.id} value={destination.id}>
                  {destination.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}
      {error !== null ? (
        <Text variant="note" role="alert">
          {error}
        </Text>
      ) : null}
      {status === 'partial' || status === 'error' ? (
        <Button
          variant="secondary"
          disabled={saving}
          onClick={() => {
            setStatus('loading');
            setError(null);
            setReloadKey((key) => key + 1);
          }}
        >
          Retry workspaces
        </Button>
      ) : null}
      <Button
        disabled={saving || destinationId === ''}
        onClick={() => {
          void transfer();
        }}
      >
        {saving ? 'Moving…' : 'Move to workspace'}
      </Button>
    </section>
  );
}
