import { Button, Dialog, Icon, Input, Text, cn, focusRing } from '@nix/ui';
import { ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { useHiddenItems } from '@nix/web-collections/items/use-hidden-items';
import type { WorkspaceTree } from '@nix/web-collections/items/use-workspace-tree';
import { ItemLandmarkIcon } from './item-landmark-dialog';
import { useItemLandmarks } from './use-item-landmarks';

/**
 * The Explorer's tree as something to open from Homebase: one folder at a time, with a path back
 * up and a filter over the folder on screen. Full screen on a phone, so Homebase is a way into the
 * files there without the drawer; a dialog over the page on wider screens.
 *
 * Opening a row opens the item; the chevron goes into it. Items hidden for the person stay hidden,
 * as they do in the Explorer.
 */
export function ExploreDialog({
  tree,
  onOpen,
  onClose,
}: {
  readonly tree: WorkspaceTree;
  readonly onOpen: (id: string) => void;
  readonly onClose: () => void;
}): ReactNode {
  const [parentId, setParentId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const visibility = useHiddenItems();
  const treeChildren = useHiddenItems('tree-children');
  const landmarks = useItemLandmarks();

  const parent = parentId === null ? null : tree.find(parentId);
  const childrenHidden = parentId !== null && treeChildren.hiddenSet.has(parentId);
  const shown = childrenHidden
    ? []
    : tree.childrenOf(parentId).filter((item) => !visibility.hiddenSet.has(item.id));
  const needle = query.trim().toLocaleLowerCase();
  const rows =
    needle === ''
      ? shown
      : shown.filter((item) => (item.title || 'Untitled').toLocaleLowerCase().includes(needle));
  const loading =
    tree.status === 'loading' || (parentId !== null && tree.isLoadingChildren(parentId));

  // Root first, then each ancestor down to the folder on screen.
  const path: { readonly id: string; readonly title: string }[] = [];
  for (let at = parent; at !== null; at = at.parentId === null ? null : tree.find(at.parentId)) {
    path.unshift({ id: at.id, title: at.title || 'Untitled' });
  }

  function browse(id: string | null): void {
    setParentId(id);
    setQuery('');
    if (id !== null) void tree.expand(id);
  }

  function open(id: string): void {
    onOpen(id);
    onClose();
  }

  const crumb = cn(
    'min-w-0 truncate rounded-sm px-1 text-left text-accent-text hover:underline',
    focusRing,
  );

  return (
    <Dialog
      open
      title="Explore"
      presentation="workspace"
      onClose={onClose}
      className="sm:max-w-2xl"
    >
      <nav aria-label="Folder path" className="shrink-0">
        <ol className="flex min-w-0 flex-wrap items-center gap-1">
          <li className="flex min-w-0 items-center">
            {parentId === null ? (
              <Text as="span" variant="bodySmall" aria-current="page" className="px-1">
                All items
              </Text>
            ) : (
              <button
                type="button"
                className={crumb}
                onClick={() => {
                  browse(null);
                }}
              >
                <Text as="span" variant="bodySmall" tone="accent">
                  All items
                </Text>
              </button>
            )}
          </li>
          {path.map((step, index) => (
            <li key={step.id} className="flex min-w-0 items-center gap-1">
              <Icon icon={ChevronRight} size="sm" className="shrink-0 text-muted" />
              {index === path.length - 1 ? (
                <Text as="span" variant="bodySmall" aria-current="page" truncate className="px-1">
                  {step.title}
                </Text>
              ) : (
                <button
                  type="button"
                  className={crumb}
                  onClick={() => {
                    browse(step.id);
                  }}
                >
                  <Text as="span" variant="bodySmall" tone="accent" truncate>
                    {step.title}
                  </Text>
                </button>
              )}
            </li>
          ))}
        </ol>
      </nav>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Input
          type="search"
          aria-label={parent ? `Filter ${parent.title || 'Untitled'}` : 'Filter all items'}
          placeholder={parent ? `Filter ${parent.title || 'Untitled'}` : 'Filter'}
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
          }}
          className="min-w-0 flex-1"
        />
        {parent ? (
          <Button
            variant="secondary"
            onClick={() => {
              open(parent.id);
            }}
          >
            Open {parent.title || 'Untitled'}
          </Button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {loading ? (
          <Text variant="note" role="status" className="p-2">
            Loading items…
          </Text>
        ) : null}
        {tree.error ? (
          <div className="flex flex-col items-start gap-1 p-2">
            <Text variant="note" role="alert">
              {tree.error}
            </Text>
            <Button
              variant="ghost"
              onClick={() => {
                if (parentId === null) void tree.reload();
                else void tree.expand(parentId);
              }}
            >
              Try again
            </Button>
          </div>
        ) : null}
        <ul aria-label={parent ? `Items in ${parent.title || 'Untitled'}` : 'All items'}>
          {rows.map((item) => {
            const title = item.title || 'Untitled';
            const browsable = item.hasChildren && !treeChildren.hiddenSet.has(item.id);
            return (
              <li key={item.id} className="flex min-w-0 items-center gap-1 border-b border-divider">
                <Button
                  variant="ghost"
                  className="min-h-(--control-lg) min-w-0 flex-1 justify-start text-left"
                  onClick={() => {
                    open(item.id);
                  }}
                >
                  <ItemLandmarkIcon landmark={landmarks.landmarks[item.id]} />
                  <Text as="span" variant="body" truncate className="min-w-0">
                    {title}
                  </Text>
                </Button>
                {browsable ? (
                  <Button
                    variant="subtle"
                    className="min-h-(--control-lg) min-w-(--control-lg) shrink-0"
                    aria-label={`Browse ${title}`}
                    onClick={() => {
                      browse(item.id);
                    }}
                  >
                    <Icon icon={ChevronRight} size="sm" />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
        {!loading && !tree.error && rows.length === 0 ? (
          <Text as="p" variant="note" tone="muted" className="p-2">
            {needle !== ''
              ? `Nothing here matches “${query.trim()}”.`
              : childrenHidden
                ? 'Children are hidden from the tree. Open this item to see them in its views.'
                : tree.childrenOf(parentId).length > 0
                  ? 'Items here are hidden for you.'
                  : 'No items here yet.'}
          </Text>
        ) : null}
      </div>
    </Dialog>
  );
}
