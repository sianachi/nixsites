import type { MenuAction, MenuEntry } from '@nix/ui';
import { Link, Star } from 'lucide-react';

import { useBookmarksStore } from '../bookmarks/use-bookmarks';
import { copyItemLink } from '@nix/web-foundation/lib/item-link';
import { publishNotice } from '@nix/web-foundation/lib/notices';
import type { HiddenItemsPreference } from './use-hidden-items';

/**
 * Menu entries that mean the same thing wherever an item appears - a sidebar row, a tab, a list
 * row, a card, a calendar entry - built once so their wording and feedback cannot drift apart.
 * They are built when a menu opens, so they read the bookmark shelf at that moment instead of
 * subscribing every row to it.
 */

export function bookmarkEntry(itemId: string): MenuEntry {
  const { keptIds, toggle } = useBookmarksStore.getState();
  return {
    kind: 'action',
    label: keptIds.has(itemId) ? 'Remove bookmark' : 'Bookmark',
    icon: Star,
    onSelect: () => {
      void toggle(itemId);
    },
  };
}

/** Copies the item's link and says whether that worked - in words a sighted person sees too. */
export function copyLinkEntry(workspaceId: string, itemId: string, title: string): MenuEntry {
  return {
    kind: 'action',
    label: 'Copy link',
    icon: Link,
    onSelect: () => {
      void copyItemLink(workspaceId, itemId).then((copied) => {
        publishNotice({
          key: 'copy-link',
          message: copied
            ? `Link to ${title || 'Untitled'} copied.`
            : 'The link could not be copied. Your browser refused access to the clipboard.',
        });
      });
    },
  };
}

export function treeChildrenEntry(
  preference: Pick<HiddenItemsPreference, 'enabled' | 'hiddenSet' | 'show' | 'hide'>,
  itemId: string,
  title: string,
): MenuAction {
  return {
    key: 'tree-children',
    label: preference.hiddenSet.has(itemId) ? 'Show children in tree' : 'Hide children from tree',
    disabled: !preference.enabled,
    onSelect: () => {
      if (preference.hiddenSet.has(itemId)) preference.show(itemId, title);
      else preference.hide(itemId, title);
    },
  };
}
