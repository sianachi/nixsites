import { items as coreItems, isCanceledError, isNixApiError } from '@nix/api-client';
import { Dialog, type MenuEntry } from '@nix/ui';
import { EyeOff } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useHiddenItems } from '@nix/web-collections/items/use-hidden-items';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { HiddenItemsList, type HiddenEntry } from './hidden-items-list';

/**
 * Hidden items as an entry for the profile menu, plus the dialog it opens. The menu sits outside
 * the panes, so an item opens through its address, as any link into the workspace does.
 */
export function useHiddenItemsEntry(): {
  readonly entry: MenuEntry | null;
  readonly dialog: ReactNode;
} {
  const visibility = useHiddenItems();
  const navigate = useNavigate();
  const { workspaceId } = useWorkspace();
  const [open, setOpen] = useState(false);
  if (!visibility.enabled) return { entry: null, dialog: null };
  return {
    entry: {
      kind: 'action',
      icon: EyeOff,
      label:
        visibility.hiddenIds.length === 0
          ? 'Hidden items'
          : `Hidden items (${String(visibility.hiddenIds.length)})`,
      onSelect: () => {
        setOpen(true);
      },
    },
    dialog: open ? (
      <Dialog
        open
        title="Hidden items"
        onClose={() => {
          setOpen(false);
        }}
      >
        <HiddenEntries
          key={visibility.scope}
          onOpen={(itemId) => {
            setOpen(false);
            void navigate(`/w/${workspaceId}?item=${encodeURIComponent(itemId)}`);
          }}
        />
      </Dialog>
    ) : null,
  };
}

function HiddenEntries({ onOpen }: { readonly onOpen: (itemId: string) => void }): ReactNode {
  const client = useApiClient();
  const visibility = useHiddenItems();
  const [loaded, setLoaded] = useState<{
    readonly ids: readonly string[];
    readonly entries: readonly HiddenEntry[];
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const [limit, setLimit] = useState(50);

  useEffect(() => {
    const controller = new AbortController();
    const ids = visibility.hiddenIds;
    const page = ids.slice(0, limit);
    async function load(): Promise<void> {
      const entries: HiddenEntry[] = [];
      // Bound requests: a large personal hidden list must not flood Core on opening this panel.
      for (let offset = 0; offset < page.length; offset += 4) {
        if (controller.signal.aborted) return;
        const batch = await Promise.all(
          page.slice(offset, offset + 4).map(async (id): Promise<HiddenEntry> => {
            try {
              const item = await client.query(coreItems.itemById(id), {
                signal: controller.signal,
                forceRefresh: retry > 0,
              });
              return { id, title: item.title || 'Untitled', failed: false };
            } catch (error) {
              if (isCanceledError(error)) throw error;
              return {
                id,
                title: null,
                failed: !isNixApiError(error) || (error.status !== 403 && error.status !== 404),
              };
            }
          }),
        );
        entries.push(...batch);
        controller.signal.throwIfAborted();
        setLoaded({ ids, entries: [...entries] });
      }
      setLoaded({ ids, entries });
    }
    void load().catch(() => {
      // Cancellation is expected when the person closes the panel or changes workspace.
    });
    return () => {
      controller.abort();
    };
  }, [client, visibility.hiddenIds, retry, limit]);

  const current = loaded?.ids === visibility.hiddenIds ? loaded.entries : [];
  const loading = current.length < Math.min(limit, visibility.hiddenIds.length);
  return (
    <HiddenItemsList
      entries={current}
      count={visibility.hiddenIds.length}
      loading={loading}
      hasMore={limit < visibility.hiddenIds.length}
      saveFailed={visibility.saveFailed}
      onOpen={onOpen}
      onShow={visibility.show}
      onShowAll={visibility.showAll}
      onRetry={() => {
        setRetry(retry + 1);
      }}
      onMore={() => {
        setLimit(limit + 50);
      }}
    />
  );
}
