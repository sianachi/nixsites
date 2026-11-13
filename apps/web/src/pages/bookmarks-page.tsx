import { Button, ContextMenu, Icon, Input, Text, focusRing, useUndo } from '@nix/ui';
import type { KeptItem } from '@nix/api-client';
import { FileText } from 'lucide-react';
import { useState, type ReactElement, type ReactNode } from 'react';
import { useOutletContext } from 'react-router';
import type { ShellContext } from '../shell/shell-context';

import { useHiddenItemPredicate } from '@nix/web-collections/items/use-hidden-items';
import { BookmarkButton } from '../bookmarks/bookmark-button';
import { useBookmarksStore } from '@nix/web-collections/items/use-bookmarks';
import {
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
  PartialNotice,
} from '@nix/web-foundation/components/states/status-panels';
import { paneScroller } from '@nix/web-foundation/layout/regions';
import { useOpenItem } from '../tabs/use-open-item';

/**
 * The bookmarks destination: what this reader has kept.
 *
 * A list rather than a grid, because a shelf is read down rather than scanned across, and every
 * entry is a title and a place - there is nothing a card would show that a row does not.
 *
 * **The hidden count is the honest part.** A bookmark outlives access to what it points at, so this
 * shelf can be holding items it cannot show: a document somebody has been removed from, or one
 * moved to the trash. The server counts them and refuses to name them, and this says the number out
 * loud. A short list looks exactly like a short shelf, and only one of those is what happened.
 */

/**
 * The destination's frame: its heading, and whatever state it is in.
 *
 * The heading is outside the state fork, for the reason the graph and calendar frames give: it
 * answers "where am I", which is true while loading, while failed, and while empty.
 */
function BookmarksFrame({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <div className={`${paneScroller} flex flex-col gap-4 break-words p-3 sm:p-4`}>
      <Text variant="h3" as="h1">
        Bookmarks
      </Text>
      {children}
    </div>
  );
}

export function BookmarksPage(): ReactElement {
  const { openExplorer } = useOutletContext<ShellContext>();
  const isHidden = useHiddenItemPredicate();
  const status = useBookmarksStore((state) => state.status);
  const items = useBookmarksStore((state) => state.items);
  const hidden = useBookmarksStore((state) => state.hidden);
  const error = useBookmarksStore((state) => state.error);

  const reload = useBookmarksStore((state) => state.reload);
  const toggle = useBookmarksStore((state) => state.toggle);
  const { openPreview } = useOpenItem();
  const undo = useUndo();
  const [query, setQuery] = useState('');
  // Rows just removed, kept on screen for the fade-out (the store drops them at once).
  const [leaving, setLeaving] = useState<ReadonlyMap<string, { item: KeptItem; index: number }>>(
    new Map(),
  );

  if (status === 'loading') {
    return (
      <BookmarksFrame>
        <LoadingPanel label="your bookmarks" />
      </BookmarksFrame>
    );
  }

  if (status === 'error') {
    return (
      <BookmarksFrame>
        <ErrorPanel
          title="Your bookmarks could not be loaded"
          detail={error ?? 'Something went wrong reading your bookmarks.'}
          action={
            <Button
              onClick={() => {
                void reload();
              }}
            >
              Try again
            </Button>
          }
        />
      </BookmarksFrame>
    );
  }

  // Nothing kept *and* nothing hidden. A shelf holding only unreachable items is not empty - saying
  // "you have not bookmarked anything" to somebody who has would be the view contradicting them.
  if (items.length === 0 && hidden === 0) {
    return (
      <BookmarksFrame>
        <EmptyPanel
          title="No bookmarks yet"
          detail="In the Explorer, open the actions for a note and choose Bookmark."
          action={
            <Button variant="secondary" onClick={openExplorer}>
              Open Explorer
            </Button>
          }
        />
      </BookmarksFrame>
    );
  }

  const reachable = items.filter((item) => !isHidden(item.itemId, item.workspaceId));
  const needle = query.trim().toLowerCase();
  const matches = (item: KeptItem): boolean =>
    needle === '' || (item.title ?? 'Untitled').toLowerCase().includes(needle);
  const visible = reachable.filter(matches);
  // Fading rows go back where they were, unless a failed removal already restored them.
  const shown = [...visible];
  for (const { item, index } of leaving.values()) {
    if (matches(item) && !shown.some((row) => row.itemId === item.itemId)) {
      shown.splice(Math.min(index, shown.length), 0, item);
    }
  }

  function remove(item: KeptItem): void {
    const title = item.title ?? 'Untitled';
    const index = reachable.findIndex((row) => row.itemId === item.itemId);
    setLeaving((cur) => new Map(cur).set(item.itemId, { item, index }));
    setTimeout(() => {
      setLeaving((cur) => {
        const next = new Map(cur);
        next.delete(item.itemId);
        return next;
      });
    }, 150);
    void toggle(item.itemId);
    undo.push(`Removed ${title}`, async () => {
      if (!useBookmarksStore.getState().keptIds.has(item.itemId)) {
        await useBookmarksStore.getState().keep(item.itemId);
      }
    });
  }

  return (
    <BookmarksFrame>
      <div className="flex flex-col gap-1">
        <Input
          type="search"
          aria-label="Search bookmarks"
          placeholder="Search bookmarks"
          autoComplete="off"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query !== '') setQuery('');
          }}
        />
        <Text role="status" variant="caption" tone="muted">
          {needle === ''
            ? `${String(reachable.length)} ${reachable.length === 1 ? 'bookmark' : 'bookmarks'}`
            : `${String(visible.length)} of ${String(reachable.length)}`}
        </Text>
      </div>
      {items.length > reachable.length ? (
        <Text role="status" variant="caption" tone="muted">
          {String(items.length - reachable.length)} hidden
        </Text>
      ) : null}
      {hidden > 0 && (
        <PartialNotice
          pending={`${String(hidden)} ${hidden === 1 ? 'bookmark is' : 'bookmarks are'} not shown, because ${hidden === 1 ? 'it points' : 'they point'} at something you can no longer open. ${hidden === 1 ? 'It is' : 'They are'} still kept.`}
        />
      )}

      {shown.length === 0 && reachable.length > 0 ? (
        <div role="status" className="flex flex-col items-center gap-2 py-8 text-center">
          <Text variant="h4" as="h2">
            No matches
          </Text>
          <Text tone="muted">Nothing is bookmarked under “{query}”.</Text>
          <Button
            onClick={() => {
              setQuery('');
            }}
          >
            Clear search
          </Button>
        </div>
      ) : null}

      {/* Named, because the tree is also a list and a reader moving between landmarks needs to
          know which one they have arrived in. */}
      <ul aria-label="Bookmarks" className="flex flex-col gap-px">
        {shown.map((item) => {
          const title = item.title ?? 'Untitled';

          return (
            <ContextMenu
              key={item.itemId}
              label={`Actions for ${title}`}
              items={[
                {
                  label: 'Open',
                  onSelect: () => {
                    openPreview(item.itemId);
                  },
                },
                {
                  label: 'Remove bookmark',
                  onSelect: () => {
                    remove(item);
                  },
                },
              ]}
            >
              {(target) => (
                <li
                  {...target}
                  data-leave={leaving.has(item.itemId) ? '' : undefined}
                  className="flex min-w-0 items-center gap-1"
                >
                  <button
                    type="button"
                    onClick={() => {
                      openPreview(item.itemId);
                    }}
                    className={`${focusRing} flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-surface pointer-coarse:min-h-11`}
                  >
                    <Icon icon={FileText} size="sm" className="shrink-0 text-muted" />
                    <Text as="span" variant="note" className="truncate">
                      {title}
                    </Text>
                  </button>

                  <BookmarkButton
                    compact
                    itemId={item.itemId}
                    title={title}
                    onToggle={() => {
                      remove(item);
                    }}
                  />
                </li>
              )}
            </ContextMenu>
          );
        })}
      </ul>
    </BookmarksFrame>
  );
}
