import { Button, Text } from '@nix/ui';
import { useEffect, type ReactElement } from 'react';

/** Warns before the page is left with edits that were never saved. */
export function useLeaveGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [dirty]);
}

/** Save, Discard and the line that says whether the form's edits are applied yet. */
export function SaveBar(props: {
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly disabled: boolean;
  readonly saved: string | null;
  readonly onDiscard: () => void;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="submit" disabled={props.saving || !props.dirty || props.disabled}>
        {props.saving ? 'Saving…' : 'Save'}
      </Button>
      <Button
        type="button"
        variant="secondary"
        disabled={props.saving || !props.dirty}
        onClick={props.onDiscard}
      >
        Discard changes
      </Button>
      <Text role="status" variant="note" tone="muted">
        {props.dirty
          ? 'Unsaved changes, not applied yet. Leaving this page discards them.'
          : (props.saved ?? 'No unsaved changes')}
      </Text>
    </div>
  );
}

/**
 * Sets back only the fields a save changed, on top of the current document, so an edit made after
 * the save survives the undo.
 */
export function revertChanged<T extends object>(before: T, after: T, current: T): T {
  const next = { ...current };
  for (const key of Object.keys(after) as (keyof T)[]) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) next[key] = before[key];
  }
  return next;
}
