import { Button, Dialog } from '@nix/ui';
import type { ReactNode } from 'react';

/**
 * The frame an editor renders in.
 *
 * A dialog when it is opened over something, a plain column when it lives in the settings panel.
 * The panel case has no Cancel - there is nothing to cancel back to, the pane is simply what is on
 * screen - and no close control of its own, because the panel already carries one.
 */
export function EditorShell(props: {
  readonly inline: boolean;
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly onSave: () => void;
  readonly saving: boolean;
  readonly saveLabel: string;
  readonly children: ReactNode;
}): ReactNode {
  const { inline, open, title, onClose, onSave, saving, saveLabel, children } = props;

  if (inline) {
    return (
      <div className="flex flex-col gap-4">
        {children}

        <Button onClick={onSave} disabled={saving} className="self-start">
          {saving ? 'Saving…' : saveLabel}
        </Button>
      </div>
    );
  }

  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : saveLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
