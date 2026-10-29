import { Button, Icon, Menu } from '@nix/ui';
import { Ellipsis } from 'lucide-react';
import type { ReactNode } from 'react';

import type { Item } from '@nix/web-collections/core/container-model';
import type { RowsProps } from './drive-rows';

/**
 * The row's actions (Rename, Move to, Download...) as a visible button, the same entries as the
 * secondary-click menu: a long press is not discoverable, and a drag is not a way to move on a phone.
 */
export function DriveRowActions(props: {
  readonly item: Item;
  readonly rowContextMenu: RowsProps['rowContextMenu'];
}): ReactNode {
  const { item, rowContextMenu } = props;
  const label = `Actions for ${item.title || 'Untitled'}`;
  return (
    <Menu label={label} items={rowContextMenu(item)}>
      {(trigger) => (
        <Button
          {...trigger}
          variant="subtle"
          className="min-w-(--control-md) any-pointer-coarse:min-w-(--control-lg)"
          aria-label={label}
        >
          <Icon icon={Ellipsis} size="sm" />
        </Button>
      )}
    </Menu>
  );
}
