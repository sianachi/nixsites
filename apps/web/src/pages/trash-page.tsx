import {
  Button,
  Checkbox,
  ContextMenu,
  Dialog,
  Icon,
  Input,
  Menu,
  Text,
  useUndo,
  type MenuEntry,
} from '@nix/ui';
import { MoreHorizontal, RotateCcw, Trash2 } from 'lucide-react';
import { isNixApiError, items as coreItems, type Item } from '@nix/api-client';
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';

const LEAVE_MS = 150;
const nameOf = (item: Item): string => item.title || 'Untitled';
const describe = (list: readonly Item[]): string => {
  const [only] = list;
  return list.length === 1 && only !== undefined
    ? `“${nameOf(only)}”`
    : `${String(list.length)} items`;
};

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import {
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
} from '@nix/web-foundation/components/states/status-panels';
import { paneScroller } from '@nix/web-foundation/layout/regions';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { notifyItemChildrenChanged } from '@nix/web-foundation/lib/item-children-changed';
import { useInRouteDialog } from '@nix/web-foundation/layout/route-dialog-context';

function Frame({ children }: { readonly children: ReactNode }): ReactElement {
  const inDialog = useInRouteDialog();
  return (
    <div
      className={`${paneScroller} flex flex-col gap-4 break-words ${inDialog ? '' : 'p-3 sm:p-4'}`}
    >
      {inDialog ? null : (
        <Text variant="h3" as="h1">
          Trash
        </Text>
      )}
      {children}
    </div>
  );
}

function Notice({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <div role="status" className="rounded-md border border-divider p-3">
      <Text variant="note" as="p">
        {children}
      </Text>
    </div>
  );
}

export function TrashPage(): ReactElement {
  const client = useApiClient();
  const { workspaceId } = useWorkspace();
  const undo = useUndo();
  const [state, setState] = useState<{
    items: readonly Item[];
    error: string | null;
    loading: boolean;
  }>({ items: [], error: null, loading: true });
  /** What is running now: the ids and the kind, with how many have finished. */
  const [busy, setBusy] = useState<{
    ids: ReadonlySet<string>;
    kind: 'restore' | 'purge';
    done: number;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState('');
  /** Rows fading out, and rows just put back by an undo. */
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const [entering, setEntering] = useState<ReadonlySet<string>>(new Set());

  /** The items awaiting the permanent-delete confirmation. Null when the dialog is closed. */
  const [purgeTarget, setPurgeTarget] = useState<readonly Item[] | null>(null);
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

  const needle = filter.trim().toLowerCase();
  const visible = state.items.filter((item) => nameOf(item).toLowerCase().includes(needle));
  // Hidden rows are never acted on: the selection is read through the filter.
  const chosen = visible.filter((item) => selected.has(item.id));
  const working = busy !== null;

  /** Fade the rows out, close the gap, then drop them. */
  const dropRows = async (list: readonly Item[]): Promise<void> => {
    const ids = new Set(list.map((item) => item.id));
    setLeaving(ids);
    await new Promise((resolve) => setTimeout(resolve, LEAVE_MS));
    setLeaving(new Set());
    setSelected((current) => new Set([...current].filter((id) => !ids.has(id))));
    setState((current) => ({
      ...current,
      items: current.items.filter((candidate) => !ids.has(candidate.id)),
    }));
  };

  /** Put rows back where they were, from the current list. */
  const putBack = (list: readonly (readonly [Item, number])[]): void => {
    setEntering(new Set(list.map(([item]) => item.id)));
    setState((current) => {
      const next = [...current.items];
      for (const [item, index] of list)
        if (!next.some((candidate) => candidate.id === item.id))
          next.splice(Math.min(index, next.length), 0, item);
      return { ...current, items: next };
    });
  };

  const restore = async (list: readonly Item[]): Promise<void> => {
    if (working || list.length === 0) return;
    const positions = list.map((item) => [item, state.items.indexOf(item)] as const);
    setNotice(null);
    const done: Item[] = [];
    const hidden: Item[] = [];
    let failed = 0;
    setBusy({ ids: new Set(list.map((item) => item.id)), kind: 'restore', done: 0 });
    for (const item of list) {
      try {
        const restored = await client.execute(coreItems.restoreItem(workspaceId, item.id));
        notifyItemChildrenChanged(workspaceId, restored.parentId, { restoredItemIds: [item.id] });
        done.push(item);
        try {
          await client.query(coreItems.itemById(item.id), { forceRefresh: true });
        } catch (reason) {
          if (isNixApiError(reason) && reason.status === 404) hidden.push(item);
        }
      } catch {
        failed += 1;
      }
      setBusy((current) => (current === null ? null : { ...current, done: current.done + 1 }));
    }
    await dropRows(done);
    setBusy(null);
    const parts = [
      done.length > 0
        ? `Restored ${describe(done)} to ${done.length === 1 ? 'its place' : 'their places'} in the workspace.`
        : '',
      hidden.length > 0
        ? `${describe(hidden)} stays hidden because ${hidden.length === 1 ? 'its' : 'their'} parent is still in Trash.`
        : '',
      failed > 0
        ? `${failed === 1 ? '1 item' : `${String(failed)} items`} could not be restored.`
        : '',
    ];
    setNotice(parts.filter(Boolean).join(' '));
    if (done.length === 0) return;
    undo.push(`Restored ${describe(done)}`, async () => {
      const back: (readonly [Item, number])[] = [];
      for (const [item, index] of positions) {
        if (!done.includes(item)) continue;
        try {
          await client.execute(coreItems.deleteItem(workspaceId, item.id));
          notifyItemChildrenChanged(workspaceId, item.parentId, { removedItemIds: [item.id] });
          back.push([item, index]);
        } catch {
          setNotice(`“${nameOf(item)}” could not be put back in Trash.`);
        }
      }
      putBack(back);
    });
  };

  const purge = async (list: readonly Item[]): Promise<void> => {
    setPurgeTarget(null);
    if (working || list.length === 0) return;
    setNotice(null);
    const done: Item[] = [];
    setBusy({ ids: new Set(list.map((item) => item.id)), kind: 'purge', done: 0 });
    for (const item of list) {
      try {
        await client.execute(coreItems.purgeItem(workspaceId, item.id));
        done.push(item);
      } catch {
        // Counted below.
      }
      setBusy((current) => (current === null ? null : { ...current, done: current.done + 1 }));
    }
    await dropRows(done);
    setBusy(null);
    const failed = list.length - done.length;
    setNotice(
      [
        done.length > 0 ? `Permanently deleted ${describe(done)}.` : '',
        failed > 0
          ? `${failed === 1 ? '1 item' : `${String(failed)} items`} could not be permanently deleted.`
          : '',
      ]
        .filter(Boolean)
        .join(' '),
    );
  };

  const progress = (kind: 'restore' | 'purge', idle: string): string =>
    busy !== null && busy.kind === kind
      ? `${kind === 'restore' ? 'Restoring' : 'Deleting'} ${String(busy.done)} of ${String(busy.ids.size)}…`
      : idle;

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
        {notice ? <Notice>{notice}</Notice> : null}
        <EmptyPanel
          title="Trash is empty"
          detail="Items you delete can be restored here until their retention period ends."
        />
      </Frame>
    );
  return (
    <Frame>
      {notice ? <Notice>{notice}</Notice> : null}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-divider bg-background py-2">
        <div className="min-w-0 basis-full sm:basis-64">
          <Input
            type="search"
            aria-label="Search Trash"
            placeholder="Search Trash"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
            }}
          />
        </div>
        <Checkbox
          label={
            chosen.length > 0
              ? `${String(chosen.length)} of ${String(visible.length)} selected`
              : `Select all (${String(visible.length)})`
          }
          checked={chosen.length > 0 && chosen.length === visible.length}
          indeterminate={chosen.length > 0 && chosen.length < visible.length}
          disabled={working || visible.length === 0}
          onChange={(event) => {
            setSelected(event.target.checked ? new Set(visible.map((item) => item.id)) : new Set());
          }}
        />
        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={working || chosen.length === 0}
            onClick={() => {
              void restore(chosen);
            }}
          >
            <Icon icon={RotateCcw} size="sm" />
            {busy?.kind === 'restore'
              ? progress('restore', '')
              : chosen.length > 0
                ? `Restore ${String(chosen.length)}`
                : 'Restore'}
          </Button>
          <Button
            variant="danger"
            disabled={working || chosen.length === 0}
            onClick={() => {
              setPurgeTarget(chosen);
            }}
          >
            {busy?.kind === 'purge'
              ? progress('purge', '')
              : chosen.length > 0
                ? `Delete ${String(chosen.length)} permanently`
                : 'Delete permanently'}
          </Button>
          <Button
            variant="danger"
            disabled={working}
            onClick={() => {
              setPurgeTarget(state.items);
            }}
          >
            {`Empty Trash (${String(state.items.length)})`}
          </Button>
        </div>
      </div>
      {visible.length === 0 ? (
        <EmptyPanel title="No matches" detail={`Nothing in Trash matches “${filter.trim()}”.`} />
      ) : (
        <ul aria-label="Trash" className="grid grid-cols-1 gap-px lg:grid-cols-2 lg:gap-x-3">
          {visible.map((item) => {
            const label = `Actions for ${nameOf(item)}`;
            const deleteAction = {
              label: 'Delete permanently',
              disabled: working,
              destructive: true,
              onSelect: () => {
                setPurgeTarget([item]);
              },
            } satisfies MenuEntry;
            return (
              <ContextMenu
                key={item.id}
                label={label}
                items={[
                  {
                    label: 'Restore',
                    disabled: working,
                    onSelect: () => {
                      void restore([item]);
                    },
                  },
                  deleteAction,
                ]}
              >
                {(target) => (
                  <li
                    {...target}
                    {...(leaving.has(item.id) ? { 'data-leave': '' } : {})}
                    {...(entering.has(item.id) ? { 'data-enter': '', 'data-flash': 'a' } : {})}
                    className={`flex flex-col gap-2 rounded-sm px-2 py-2 hover:bg-surface sm:flex-row sm:items-center sm:gap-3 ${selected.has(item.id) ? 'bg-surface' : ''}`}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <Checkbox
                        aria-label={`Select ${nameOf(item)}`}
                        checked={selected.has(item.id)}
                        disabled={working}
                        onChange={(event) => {
                          const on = event.target.checked;
                          setSelected((current) => {
                            const next = new Set(current);
                            if (on) next.add(item.id);
                            else next.delete(item.id);
                            return next;
                          });
                        }}
                      />
                      <Icon icon={Trash2} size="sm" className="shrink-0 text-muted" />
                      <Text
                        variant="note"
                        as="span"
                        className="min-w-0 flex-1 break-words sm:truncate"
                      >
                        {nameOf(item)}
                      </Text>
                    </div>
                    <div className="flex min-w-0 items-center justify-end gap-2 sm:ml-auto">
                      <Button
                        className="min-w-0 justify-center"
                        variant="secondary"
                        aria-label={`Restore ${nameOf(item)}`}
                        disabled={working}
                        onClick={() => {
                          void restore([item]);
                        }}
                      >
                        <Icon icon={RotateCcw} size="sm" />
                        {busy?.kind === 'restore' && busy.ids.has(item.id)
                          ? 'Restoring…'
                          : 'Restore'}
                      </Button>
                      <Menu label={label} items={[deleteAction]}>
                        {(trigger) => (
                          <Button {...trigger} variant="subtle" aria-label={label} title={label}>
                            <Icon icon={MoreHorizontal} size="sm" />
                          </Button>
                        )}
                      </Menu>
                    </div>
                  </li>
                )}
              </ContextMenu>
            );
          })}
        </ul>
      )}
      <Dialog
        open={purgeTarget !== null}
        title={purgeTarget === null ? '' : `Delete ${describe(purgeTarget)} permanently?`}
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
              variant="danger"
              onClick={() => {
                if (purgeTarget !== null) void purge(purgeTarget);
              }}
            >
              Delete permanently
            </Button>
          </>
        }
      >
        {purgeTarget !== null && purgeTarget.length > 1 ? (
          <ul className="mb-2 list-disc pl-5">
            {purgeTarget.slice(0, 5).map((item) => (
              <li key={item.id}>
                <Text variant="bodySmall">{nameOf(item)}</Text>
              </li>
            ))}
            {purgeTarget.length > 5 ? (
              <li>
                <Text variant="bodySmall">{`and ${String(purgeTarget.length - 5)} more`}</Text>
              </li>
            ) : null}
          </ul>
        ) : null}
        <Text variant="bodySmall">This can’t be undone.</Text>
      </Dialog>
    </Frame>
  );
}
