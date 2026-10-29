import { Button, Dialog, Field, Input, Text } from '@nix/ui';
import { useRef, useState, type ReactNode } from 'react';
import { MobileDestinationPicker } from '@nix/web-collections/items/mobile-destination-picker';
import type { WorkspaceTree } from '@nix/web-collections/items/use-workspace-tree';

/** Kept mounted by the workspace shell so closing the sheet retains an unfinished title. */
export function MobileNoteCapture({
  open,
  tree,
  onClose,
  onCreated,
}: {
  readonly open: boolean;
  readonly tree: WorkspaceTree;
  readonly onClose: () => void;
  readonly onCreated: (id: string) => void;
}): ReactNode {
  const [title, setTitle] = useState('');
  const [parentId, setParentId] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  async function create(): Promise<void> {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      const outcome = await tree.create(parentId, title.trim() || 'Untitled note');
      if (outcome.id === null) {
        setError(outcome.refusal ?? 'The note could not be created.');
        return;
      }
      setTitle('');
      setChoosing(false);
      onClose();
      onCreated(outcome.id);
    } catch {
      setError('The note could not be created. Check the workspace before retrying.');
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }
  return (
    <Dialog
      open={open}
      title="New note"
      initialFocus={input}
      swipeToClose={!saving}
      onClose={() => {
        if (!pending.current) onClose();
      }}
      actions={
        <Button
          disabled={saving}
          onClick={() => {
            void create();
          }}
        >
          {saving ? 'Creating…' : 'Create note'}
        </Button>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
        className="flex min-w-0 flex-col gap-3"
      >
        <Field label="Note title">
          {(control) => (
            <Input
              {...control}
              ref={input}
              value={title}
              disabled={saving}
              placeholder="Untitled note"
              enterKeyHint="done"
              onChange={(event) => {
                setTitle(event.target.value);
              }}
            />
          )}
        </Field>
        <Button
          variant="secondary"
          className="min-w-0"
          disabled={saving}
          aria-expanded={choosing}
          onClick={() => {
            setChoosing(!choosing);
          }}
        >
          <span className="min-w-0 truncate">
            Create in:{' '}
            {parentId === null ? 'Workspace' : (tree.find(parentId)?.title ?? '') || 'Untitled'}
          </span>
        </Button>
        {choosing ? (
          <MobileDestinationPicker
            tree={tree}
            parentId={parentId}
            onChange={setParentId}
            disabled={saving}
          />
        ) : null}
        {error ? (
          <Text variant="note" role="alert">
            {error}
          </Text>
        ) : null}
        <Text variant="caption" tone="muted">
          Closing keeps this title until you leave the workspace. Create the note to start writing.
        </Text>
      </form>
    </Dialog>
  );
}
