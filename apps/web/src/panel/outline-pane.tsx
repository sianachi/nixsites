import { Button, Text } from '@nix/ui';
import { useEffect, useState, type ReactNode } from 'react';

import { useActiveEditor } from '@nix/web-editor/editor/active-editor';
import {
  jumpToHeading,
  readNoteStats,
  type NoteOutlineEntry,
} from '@nix/web-editor/editor/note-stats';

const INDENT = ['', 'pl-3', 'pl-6', 'pl-9', 'pl-12', 'pl-15'] as const;

/**
 * The headings of the open note, read from the live editor document, so it works offline.
 * Anything without a note body (a collection, a file) has no editor and shows the empty state.
 */
export function OutlinePane(): ReactNode {
  const editor = useActiveEditor();
  const [outline, setOutline] = useState<readonly NoteOutlineEntry[]>([]);

  useEffect(() => {
    if (editor === null) return;
    const read = (): void => {
      setOutline(readNoteStats(editor.state.doc).outline);
    };
    read();
    editor.on('update', read);
    return () => {
      editor.off('update', read);
    };
  }, [editor]);

  if (editor === null || outline.length === 0) {
    return (
      <Text variant="bodySmall" tone="muted">
        {editor === null ? 'Open a note to see its outline.' : 'No headings yet.'}
      </Text>
    );
  }

  return (
    <ul className="flex list-none flex-col p-0">
      {outline.map((entry, index) => (
        <li key={entry.pos} className={INDENT[entry.level - 1] ?? 'pl-15'}>
          <Button
            variant="subtle"
            className="w-full justify-start"
            onClick={() => {
              jumpToHeading(editor, index, entry.pos);
            }}
          >
            {entry.text || 'Untitled heading'}
          </Button>
        </li>
      ))}
    </ul>
  );
}
