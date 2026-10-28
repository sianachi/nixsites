import { Button, ContextMenu, Dialog, Icon, Text } from '@nix/ui';
import { RotateCcw, Trash2 } from 'lucide-react';
import { isNixApiError, items as coreItems, type Item } from '@nix/api-client';
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import {
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
} from '@nix/web-foundation/components/states/status-panels';
import { paneScroller } from '@nix/web-foundation/layout/regions';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { notifyItemChildrenChanged } from '@nix/web-foundation/lib/item-children-changed';

function Frame({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <div className={`${paneScroller} flex flex-col gap-4 break-words p-3 sm:p-4`}>
      <Text variant="h3" as="h1">
        Trash
      </Text>
      {children}
    </div>
  );
}

export function TrashPage(): ReactElement {
  const client = useApiClient();
  const { workspaceId } = useWorkspace();
  const [state, setState] = useState<{
    items: readonly Item[];
    error: string | null;
    loading: boolean;
  }>({ items: [], error: null, loading: true });
  const [restoring, setRestoring] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** The item awaiting the permanent-delete confirmation. Null when the dialog is closed. */
  const [purgeTarget, setPurgeTarget] = useState<Item | null>(null);
  const purgeCancelRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async (): Promise<void> => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const found: Item[] = [];
      for await (const item of client.paginate(coreItems.listTrash(workspaceId, 200)))
        found.push(item);
      setState({ items: found, error: null, loading: false });
    } catch {
      setState({ items: [], loading: false, error: 'Trash could not be loaded.' });
    }
  }, [client, workspaceId]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const restore = async (item: Item): Promise<void> => {
    setRestoring(item.id);
    setNotice(null);
    try {
      const restored = await client.execute(coreItems.restoreItem(workspaceId, item.id));
      notifyItemChildrenChanged(workspaceId, restored.parentId, { restoredItemIds: [item.id] });
      setState((current) => ({
        ...current,
        items: current.items.filter((candidate) => candidate.id !== item.id),
      }));
      try {
        await client.query(coreItems.itemById(item.id), { forceRefresh: true });
        setNotice(`Restored “${item.title || 'Untitled'}”.`);
      } catch (reason) {
        setNotice(
          isNixApiError(reason) && reason.status === 404
            ? `Restored “${item.title || 'Untitled'}”, but it remains hidden because its parent is still in Trash.`
            : `Restored “${item.title || 'Untitled'}”.`,
        );
      }
    } catch {
      setNotice(`“${item.title || 'Untitled'}” could not be restored.`);
    } finally {
      setRestoring(null);
    }
  };
  const purge = async (item: Item): Promise<void> => {
    setPurgeTarget(null);
    setRestoring(item.id);
    try {
      await client.execute(coreItems.purgeItem(workspaceId, item.id));
      setState((current) => ({
        ...current,
        items: current.items.filter((candidate) => candidate.id !== item.id),
      }));
      setNotice(`Permanently deleted “${item.title || 'Untitled'}”.`);
    } catch {
      setNotice(`“${item.title || 'Untitled'}” could not be permanently deleted.`);
    } finally {
      setRestoring(null);
    }
  };

  if (state.loading)
    return (
      <Frame>
        <LoadingPanel label="trash" />
      </Frame>
    );
  if (state.error)
    return (
      <Frame>
        <ErrorPanel
          title="Trash could not be loaded"
          detail={state.error}
          action={
            <Button
              onClick={() => {
                void load();
              }}
            >
              Try again
            </Button>
          }
        />
      </Frame>
    );
  if (state.items.length === 0)
    return (
      <Frame>
        {notice ? (
          <Text variant="note" as="p" role="status">
            {notice}
          </Text>
        ) : null}
        <EmptyPanel
          title="Trash is empty"
          detail="Items you delete can be restored here until their retention period ends."
        />
      </Frame>
    );
  return (
    <Frame>
      {notice ? (
        <Text variant="note" as="p" role="status">
          {notice}
        </Text>
      ) : null}
      <ul aria-label="Trash" className="flex flex-col gap-px">
        {state.items.map((item) => (
          <ContextMenu
            key={item.id}
            label={`Actions for ${item.title || 'Untitled'}`}
            items={[
              {
                label: 'Restore',
                disabled: restoring !== null,
                onSelect: () => {
                  void restore(item);
                },
              },
              {
                label: 'Delete permanently',
                disabled: restoring !== null,
                destructive: true,
                onSelect: () => {
                  setPurgeTarget(item);
                },
              },
            ]}
          >
            {(target) => (
              <li
                {...target}
                className="flex flex-col gap-2 rounded-sm px-2 py-2 hover:bg-surface sm:flex-row sm:items-center sm:gap-3"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <Icon icon={Trash2} size="sm" className="shrink-0 text-muted" />
                  <Text variant="note" as="span" className="min-w-0 flex-1 break-words sm:truncate">
                    {item.title || 'Untitled'}
                  </Text>
                </div>
                <div className="flex min-w-0 flex-col gap-2 pl-7 sm:ml-auto sm:flex-row sm:pl-0">
                  <Button
                    className="min-w-0 flex-1 justify-center sm:flex-none"
                    variant="secondary"
                    disabled={restoring !== null}
                    onClick={() => {
                      void restore(item);
                    }}
                  >
                    <Icon icon={RotateCcw} size="sm" />
                    {restoring === item.id ? 'Restoring…' : 'Restore'}
                  </Button>
                  <Button
                    className="min-w-0 flex-1 justify-center text-center sm:flex-none"
                    variant="primary"
                    disabled={restoring !== null}
                    onClick={() => {
                      setPurgeTarget(item);
                    }}
                  >
                    Delete permanently
                  </Button>
                </div>
              </li>
            )}
          </ContextMenu>
        ))}
      </ul>
      <Dialog
        open={purgeTarget !== null}
        title={`Delete “${purgeTarget === null ? '' : purgeTarget.title || 'Untitled'}” permanently?`}
        onClose={() => {
          setPurgeTarget(null);
        }}
        initialFocus={purgeCancelRef}
        actions={
          <>
            <Button
              ref={purgeCancelRef}
              variant="secondary"
              onClick={() => {
                setPurgeTarget(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (purgeTarget !== null) void purge(purgeTarget);
              }}
            >
              Delete permanently
            </Button>
          </>
        }
      >
        <Text variant="bodySmall">This can’t be undone.</Text>
      </Dialog>
    </Frame>
  );
}
