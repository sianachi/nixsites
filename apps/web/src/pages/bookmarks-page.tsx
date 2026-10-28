import { Button, ContextMenu, Icon, Text, focusRing } from '@nix/ui';
import { FileText } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

import { useHiddenItemPredicate } from '../items/use-hidden-items';
import { BookmarkButton } from '../bookmarks/bookmark-button';
import { useBookmarksStore } from '../bookmarks/use-bookmarks';
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
  const isHidden = useHiddenItemPredicate();
  const status = useBookmarksStore((state) => state.status);
  const items = useBookmarksStore((state) => state.items);
  const hidden = useBookmarksStore((state) => state.hidden);
  const error = useBookmarksStore((state) => state.error);

  const reload = useBookmarksStore((state) => state.reload);
  const toggle = useBookmarksStore((state) => state.toggle);
  const { openPreview } = useOpenItem();

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
          title="Nothing kept yet"
          detail="Bookmark a note from the Explorer, from the document itself, or from the command palette, and it will appear here."
        />
      </BookmarksFrame>
    );
  }

  const visible = items.filter((item) => !isHidden(item.itemId, item.workspaceId));
  return (
    <BookmarksFrame>
      {visible.length < items.length ? (
        <Text role="status" variant="caption" tone="muted">
          {String(items.length - visible.length)} hidden
        </Text>
      ) : null}
      {hidden > 0 && (
        <PartialNotice
          pending={`${String(hidden)} ${hidden === 1 ? 'bookmark is' : 'bookmarks are'} not shown, because ${hidden === 1 ? 'it points' : 'they point'} at something you can no longer open. ${hidden === 1 ? 'It is' : 'They are'} still kept.`}
        />
      )}

      {/* Named, because the tree is also a list and a reader moving between landmarks needs to
          know which one they have arrived in. */}
      <ul aria-label="Bookmarks" className="flex flex-col gap-px">
        {visible.map((item) => {
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
                    void toggle(item.itemId);
                  },
                },
              ]}
            >
              {(target) => (
                <li {...target} className="flex min-w-0 items-center gap-1">
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

                  <BookmarkButton compact itemId={item.itemId} title={title} />
                </li>
              )}
            </ContextMenu>
          );
        })}
      </ul>
    </BookmarksFrame>
  );
}
