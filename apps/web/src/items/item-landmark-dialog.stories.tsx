import { Button, Text } from '@nix/ui';
import { useState, type ReactNode } from 'react';

import { ItemLandmarkDialog, ItemLandmarkIcon } from './item-landmark-dialog';
import type { ItemLandmark } from '@nix/web-foundation/lib/item-landmarks';

export default { title: 'Nix/Items/Item landmarks', parameters: { layout: 'padded' } };

function Example({ initial = { icon: 'notebook', tone: 'accent' } as ItemLandmark }): ReactNode {
  const [open, setOpen] = useState(true);
  const [landmark, setLandmark] = useState<ItemLandmark | undefined>(initial);
  return (
    <>
      <Button
        variant="ghost"
        onClick={() => {
          setOpen(true);
        }}
      >
        <ItemLandmarkIcon landmark={landmark} />
        <Text as="span" variant="bodySmall">
          Personal journal
        </Text>
      </Button>
      {open ? (
        <ItemLandmarkDialog
          title="Personal journal"
          landmark={landmark}
          onSave={(choice) => {
            setLandmark(choice ?? undefined);
          }}
          onClose={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

export const PersonalJournal = { render: (): ReactNode => <Example /> };
export const DefaultIcon = {
  render: (): ReactNode => <Example initial={{ icon: 'page', tone: 'muted' }} />,
};
export const DarkJournal = { ...PersonalJournal, globals: { ground: 'dark' } };
