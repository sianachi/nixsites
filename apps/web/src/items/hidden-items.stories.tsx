import { Button, Menu } from '@nix/ui';
import { treeChildrenEntry } from '../collections/items/item-menu-entries';
import { useState, type ReactNode } from 'react';

import { HiddenItemsList, type HiddenEntry } from './hidden-items-list';

export default { title: 'Nix/Items/Hidden items', parameters: { layout: 'padded' } };
const noop = () => undefined;

function Example({
  loading = false,
  failed = false,
  unavailable = false,
  empty = false,
  saveFailed = false,
}) {
  const [entries, setEntries] = useState<readonly HiddenEntry[]>(
    empty
      ? []
      : [
          { id: 'one', title: 'Meeting notes', failed: false },
          { id: 'two', title: unavailable || failed ? null : 'Old project plan', failed },
        ],
  );
  return (
    <div className="max-w-sm">
      <HiddenItemsList
        entries={entries}
        count={loading ? 70 : entries.length}
        loading={loading}
        hasMore={loading}
        saveFailed={saveFailed}
        onOpen={noop}
        onShow={(id) => {
          setEntries(entries.filter((entry) => entry.id !== id));
        }}
        onShowAll={() => {
          setEntries([]);
        }}
        onRetry={noop}
        onMore={noop}
      />
    </div>
  );
}
export const Ready = { render: (): ReactNode => <Example /> };
export const Loading = { render: (): ReactNode => <Example loading /> };
export const RequestFailed = { render: (): ReactNode => <Example failed /> };
export const Unavailable = { render: (): ReactNode => <Example unavailable /> };
export const StorageUnavailable = { render: (): ReactNode => <Example saveFailed /> };
export const Empty = { render: (): ReactNode => <Example empty /> };
export const DarkReady = { ...Ready, globals: { ground: 'dark' } };

function TreeChildrenExample() {
  const [hidden, setHidden] = useState(false);
  return (
    <Menu
      label="Item actions"
      items={[
        treeChildrenEntry(
          {
            enabled: true,
            hiddenSet: new Set(hidden ? ['note'] : []),
            hide: () => {
              setHidden(true);
            },
            show: () => {
              setHidden(false);
            },
          },
          'note',
          'Meeting notes',
        ),
      ]}
    >
      {(trigger) => <Button {...trigger}>Item actions</Button>}
    </Menu>
  );
}
export const TreeChildren = {
  render: (): ReactNode => <TreeChildrenExample />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    canvasElement.querySelector('button')?.click();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => {
        resolve();
      }),
    );
  },
};
