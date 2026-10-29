import { Button, Icon } from '@nix/ui';
import { Download } from 'lucide-react';
import type { ReactNode } from 'react';

import { useOptionalItemSelection } from '@nix/web-collections/core/item-selection-context';
import type { Item } from '@nix/web-collections/core/container-model';

export function DriveDownloadAction({
  rows,
  onDownload,
}: {
  readonly rows: readonly Item[];
  readonly onDownload: (items: readonly Item[]) => Promise<void>;
}): ReactNode {
  const selection = useOptionalItemSelection();
  if (selection === null) return null;
  return (
    <Button
      variant="secondary"
      onClick={() => {
        void onDownload(rows.filter((row) => selection.selected.has(row.id)));
      }}
    >
      <Icon icon={Download} size="sm" />
      Download
    </Button>
  );
}
