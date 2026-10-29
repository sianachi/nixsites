import { Button, Dialog, Field, Input, Text } from '@nix/ui';
import { useState, type ReactNode } from 'react';

export interface RenameItemDialogProps {
  readonly title: string;
  readonly onClose: () => void;
  /** Saves the title; answers with a refusal to show, or null when stored. */
  readonly onRename: (title: string) => Promise<string | null>;
}

/** A title edit for a view that has no inline title control of its own. */
export function RenameItemDialog({ title, onClose, onRename }: RenameItemDialogProps): ReactNode {
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = draft.trim();

  function save(): void {
    if (trimmed.length === 0 || saving) return;
    setSaving(true);
    setError(null);
    void onRename(trimmed)
      .then((refusal) => {
        if (refusal === null) onClose();
        else setError(refusal);
      })
      .finally(() => {
        setSaving(false);
      });
  }

  return (
    <Dialog
      open
      title="Rename"
      onClose={() => {
        if (!saving) onClose();
      }}
      actions={
        <>
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving || trimmed.length === 0 || trimmed === title} onClick={save}>
            {saving ? 'Saving…' : 'Rename'}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <Field label="Title">
          {(control) => (
            <Input
              {...control}
              value={draft}
              maxLength={500}
              onChange={(event) => {
                setDraft(event.currentTarget.value);
              }}
            />
          )}
        </Field>
      </form>
      {error === null ? null : (
        <Text as="p" variant="note" role="alert">
          {error}
        </Text>
      )}
    </Dialog>
  );
}
