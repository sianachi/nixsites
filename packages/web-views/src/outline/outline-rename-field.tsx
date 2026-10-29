import { Input } from '@nix/ui';
import { useEffect, useRef, type ReactNode } from 'react';

/**
 * The title as a field, in the row's own place: Enter or leaving it saves, Escape drops the edit.
 * The caller treats an empty or unchanged title as a cancel.
 */
export function RenameField({
  title,
  onCommit,
  onCancel,
}: {
  readonly title: string;
  readonly onCommit: (title: string) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const fieldRef = useRef<HTMLInputElement>(null);
  // Enter and Escape unmount the field, and the blur that follows must not save a second time.
  const settled = useRef(false);

  useEffect(() => {
    fieldRef.current?.focus();
    fieldRef.current?.select();
  }, []);

  return (
    <Input
      ref={fieldRef}
      aria-label={`Rename ${title.length > 0 ? title : 'Untitled'}`}
      defaultValue={title}
      className="min-w-0 flex-1"
      onClick={(event) => {
        event.stopPropagation();
      }}
      onBlur={(event) => {
        if (settled.current) return;
        settled.current = true;
        onCommit(event.currentTarget.value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          settled.current = true;
          onCommit(event.currentTarget.value);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          settled.current = true;
          onCancel();
        }
      }}
    />
  );
}
