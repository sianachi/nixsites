import { Dialog, Icon, Text, cn, focusRing } from '@nix/ui';
import { FileText, Grid3x3, Plus, Shapes, X, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { useTabStore, type OpenTab } from '@nix/web-foundation/lib/tab-store';
import { useSelectedItem } from '@nix/web-platform/routing/selected-item';
import type { ShellContext } from '../shell-context';
import { useOpenItem } from '../../tabs/use-open-item';

function iconForType(type: string | undefined): LucideIcon {
  if (type === 'canvas') return Shapes;
  if (type === 'spreadsheet') return Grid3x3;
  return FileText;
}

export interface TabSwitcherProps {
  readonly tabs: readonly OpenTab[];
  readonly activeId: string | null;
  readonly tree: ShellContext['tree'];
  readonly onNew: () => void;
  readonly onClose: () => void;
}

/** Obsidian's tab switcher: a grid of cards, the active one outlined, and a "+ / N tabs / Done" row. */
export function TabSwitcher({ tabs, activeId, tree, onNew, onClose }: TabSwitcherProps): ReactNode {
  const { activateTab } = useOpenItem();
  const { clear } = useSelectedItem();
  const tabClosed = useTabStore((state) => state.tabClosed);

  function closeTab(itemId: string): void {
    const index = tabs.findIndex((tab) => tab.itemId === itemId);
    const remaining = tabs.filter((tab) => tab.itemId !== itemId);
    tabClosed(itemId);
    if (remaining.length === 0) clear();
    else if (itemId === activeId) {
      // The left neighbour, else the right: the desktop strip's convention.
      const neighbor = remaining[Math.max(0, index - 1)];
      if (neighbor !== undefined) activateTab(neighbor.itemId);
    }
  }

  const count = `${String(tabs.length)} ${tabs.length === 1 ? 'tab' : 'tabs'}`;
  return (
    <Dialog
      open
      title="Open tabs"
      titleHidden
      closeLabel="Close tabs"
      presentation="workspace"
      onClose={onClose}
    >
      <ul className="grid min-h-0 flex-1 auto-rows-min grid-cols-2 content-start gap-3 overflow-y-auto pt-10">
        {tabs.map((tab) => {
          const item = tree.find(tab.itemId);
          const named = item?.title ?? '';
          const title = named.length > 0 ? named : 'Untitled';
          const active = tab.itemId === activeId;
          return (
            <li
              key={tab.itemId}
              className={cn(
                'relative flex aspect-[3/4] min-w-0 flex-col rounded-lg border-2 bg-surface',
                active ? 'border-accent' : 'border-divider',
              )}
            >
              <button
                type="button"
                aria-label={title}
                aria-current={active}
                className={cn(
                  'flex min-h-0 flex-1 flex-col gap-2 rounded-lg p-3 text-left',
                  focusRing,
                )}
                onClick={() => {
                  activateTab(tab.itemId);
                  onClose();
                }}
              >
                <Icon icon={iconForType(item?.type)} size="md" className="text-muted" />
                <Text variant="body" className="line-clamp-4 break-words font-semibold">
                  {title}
                </Text>
              </button>
              <button
                type="button"
                aria-label={`Close ${title}`}
                className={cn(
                  'absolute right-1 top-1 flex size-(--control-lg) items-center justify-center rounded-full text-muted',
                  focusRing,
                )}
                onClick={() => {
                  closeTab(tab.itemId);
                }}
              >
                <Icon icon={X} size="sm" />
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex shrink-0 items-center justify-between">
        <button
          type="button"
          aria-label="New tab"
          className={cn(
            'flex size-(--control-lg) items-center justify-center rounded-full',
            focusRing,
          )}
          onClick={() => {
            onNew();
            onClose();
          }}
        >
          <Icon icon={Plus} size="sm" />
        </button>
        <Text variant="body" tone="muted">
          {count}
        </Text>
        <button
          type="button"
          className={cn(
            'min-h-(--control-lg) rounded-full px-4 font-semibold text-accent',
            focusRing,
          )}
          onClick={onClose}
        >
          Done
        </button>
      </div>
    </Dialog>
  );
}
