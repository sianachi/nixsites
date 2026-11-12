import { search, type SearchResults } from '@nix/api-client';
import { Button, Input, Text } from '@nix/ui';
import { useHiddenItems } from '@nix/web-collections/items/use-hidden-items';
import type { WorkspaceTree } from '@nix/web-collections/items/use-workspace-tree';
import type { ItemLandmarks } from '@nix/web-foundation/lib/item-landmarks';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { ItemLandmarkIcon } from './item-landmark-dialog';

export function ExplorerSearch({
  tree,
  landmarks,
  onOpen,
  searchRef,
  action,
  children,
}: {
  readonly tree: WorkspaceTree;
  readonly landmarks: ItemLandmarks;
  readonly onOpen: (id: string) => void;
  readonly searchRef?: RefObject<HTMLInputElement | null> | undefined;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  const { workspaceId } = useWorkspace();
  const client = useApiClient();
  const { hiddenSet } = useHiddenItems();
  const [query, setQuery] = useState('');
  const [answer, setAnswer] = useState<{
    readonly query: string;
    readonly results: SearchResults | null;
  } | null>(null);
  const needle = query.trim();

  useEffect(() => {
    if (needle.length < 3) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void client.query(search.searchItems(needle, 50), { signal: controller.signal }).then(
        (results) => {
          if (!controller.signal.aborted) setAnswer({ query: needle, results });
        },
        () => {
          if (!controller.signal.aborted) setAnswer({ query: needle, results: null });
        },
      );
    }, 150);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [client, needle]);

  const current = answer?.query === needle ? answer : null;
  const hits =
    current?.results?.results.filter(
      (hit) => hit.workspaceId === workspaceId && !hiddenSet.has(hit.id),
    ) ?? [];
  const status =
    needle.length < 3
      ? 'Enter at least 3 characters to search.'
      : current === null
        ? 'Searching…'
        : current.results === null
          ? 'Search is unavailable right now.'
          : hits.length === 0 && !current.results.truncated
            ? 'No matching items in this workspace.'
            : null;

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 px-3 py-1">
        <Input
          ref={searchRef}
          type="search"
          aria-label="Search Explorer"
          placeholder="Search Explorer"
          value={query}
          className="min-w-0 flex-1 pointer-coarse:min-h-(--control-lg)"
          onChange={(event) => {
            const next = event.currentTarget.value;
            if (next.trim() !== needle) setAnswer(null);
            setQuery(next);
          }}
        />
        {action}
      </div>
      <div className={needle === '' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>{children}</div>
      {needle === '' ? null : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {status === null ? null : (
            <Text variant="note" tone="muted" role="status" className="p-2">
              {status}
            </Text>
          )}
          {hits.length === 0 ? null : (
            <ul aria-label="Explorer search results">
              {hits.map((hit) => (
                <li key={hit.id}>
                  <Button
                    variant="ghost"
                    className="w-full min-w-0 justify-start text-left pointer-coarse:min-h-(--control-lg)"
                    onClick={() => {
                      onOpen(hit.id);
                      setQuery('');
                      setAnswer(null);
                      searchRef?.current?.focus();
                    }}
                  >
                    <ItemLandmarkIcon
                      landmark={landmarks[hit.id]}
                      item={tree.find(hit.id) ?? { type: hit.type, title: hit.title ?? '' }}
                    />
                    <Text as="span" variant="body" truncate>
                      {hit.title ?? 'Untitled'}
                    </Text>
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {current?.results?.truncated === true ? (
            <Text variant="note" tone="muted" className="p-2">
              Refine your search to see more matches.
            </Text>
          ) : null}
        </div>
      )}
    </>
  );
}
