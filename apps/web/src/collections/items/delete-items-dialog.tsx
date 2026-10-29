import { Button, Dialog, Text } from '@nix/ui';
import { useState, type ReactNode } from 'react';

import { describeDeleteConfirm, type BulkDeletePlan } from './bulk-delete';

export interface DeleteItemsDialogProps {
  readonly plan: BulkDeletePlan;
  readonly onClose: () => void;
  /** Runs the deletes; the dialog stays up, busy, until they settle. */
  readonly onConfirm: () => Promise<void>;
}

/** The one confirmation a bulk delete asks for: the count, what goes with it, and what is left out. */
export function DeleteItemsDialog({ plan, onClose, onConfirm }: DeleteItemsDialogProps): ReactNode {
  const [saving, setSaving] = useState(false);
  const words = describeDeleteConfirm(plan);

  return (
    <Dialog
      open
      title={words.title}
      onClose={() => {
        if (!saving) onClose();
      }}
      actions={
        <>
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            {words.confirm === null ? 'Close' : 'Cancel'}
          </Button>
          {words.confirm === null ? null : (
            <Button
              disabled={saving}
              onClick={() => {
                setSaving(true);
                void onConfirm().finally(onClose);
              }}
            >
              {saving ? 'Deleting…' : words.confirm}
            </Button>
          )}
        </>
      }
    >
      {words.body.map((sentence) => (
        <Text key={sentence} as="p" variant="body">
          {sentence}
        </Text>
      ))}
    </Dialog>
  );
}
