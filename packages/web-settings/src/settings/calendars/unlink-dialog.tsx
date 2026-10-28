import { Button, Dialog, Text } from '@nix/ui';
import { useState, type ReactElement } from 'react';

interface UnlinkDialogProps {
  /** What the calendar is called on this screen. */
  readonly name: string;

  /** Performs the unlink: the caller's own link, or another member's on a manager's authority. */
  readonly unlink: (items: 'keep' | 'trash') => Promise<{ readonly refusal: string | null }>;
  readonly onClose: () => void;
}

/** Asks what should become of a linked calendar's notes, then unlinks it. */
export function UnlinkDialog({ name, unlink: run, onClose }: UnlinkDialogProps): ReactElement {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);

  async function unlink(items: 'keep' | 'trash'): Promise<void> {
    setInFlight(true);
    setRefusal(null);
    try {
      const outcome = await run(items);
      if (outcome.refusal !== null) {
        // The dialog stays open over a failure: closing it would report an unlink that never
        // happened.
        setRefusal(outcome.refusal);
        return;
      }
      onClose();
    } finally {
      setInFlight(false);
    }
  }

  return (
    <Dialog
      open
      title={`Unlink ${name}?`}
      onClose={() => {
        if (!inFlight) {
          onClose();
        }
      }}
      closeLabel="Keep the link"
      actions={
        <>
          <Button variant="secondary" disabled={inFlight} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            disabled={inFlight}
            onClick={() => {
              void unlink('trash');
            }}
          >
            {inFlight ? 'Unlinking' : 'Unlink and move notes to trash'}
          </Button>
          <Button
            disabled={inFlight}
            onClick={() => {
              void unlink('keep');
            }}
          >
            {inFlight ? 'Unlinking' : 'Unlink and keep notes'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <Text variant="bodySmall">
          Syncing stops either way, and nothing is removed from the calendar itself. Choose what
          happens to the notes this link created in the workspace.
        </Text>
        <Text variant="bodySmall">
          Kept notes become ordinary items you can edit and delete. Trashed notes can be restored
          from the trash.
        </Text>
        {refusal === null ? null : (
          <Text variant="note" role="alert">
            {refusal}
          </Text>
        )}
      </div>
    </Dialog>
  );
}
