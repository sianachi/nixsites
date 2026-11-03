import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Button, Popover, Text } from '@nix/ui';
import { useEffect, useState, type ReactNode } from 'react';

/** Each heading level indents one step further in the outline. */
const OUTLINE_INDENT = ['', 'pl-3', 'pl-6', 'pl-9', 'pl-12', 'pl-15'] as const;

const WORDS_PER_MINUTE = 230;
const DEBOUNCE_MS = 400;

export interface NoteOutlineEntry {
  readonly pos: number;
  readonly level: number;
  readonly text: string;
}

export interface NoteStats {
  readonly words: number;
  readonly minutes: number;
  readonly outline: readonly NoteOutlineEntry[];
}

/** The note as it reads now: text proposed for deletion is left out, proposed insertions stay in. */
export function readNoteStats(doc: ProseMirrorNode): NoteStats {
  const outline: NoteOutlineEntry[] = [];
  let words = 0;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = '';
    node.forEach((child) => {
      if (child.isText) {
        if (!child.marks.some((m) => m.type.name === 'suggestionDelete')) text += child.text ?? '';
      } else if (child.isLeaf) text += ' '; // hard breaks and other inline leaves separate words
    });
    words += text.split(/\s+/).filter(Boolean).length;
    if (node.type.name === 'heading') {
      outline.push({ pos, level: Number(node.attrs.level ?? 1), text: text.trim() });
    }
    return false;
  });
  return { words, minutes: Math.max(1, Math.ceil(words / WORDS_PER_MINUTE)), outline };
}

/** Moves the caret to the `index`th heading and scrolls it into view. */
export function jumpToHeading(editor: Editor, index: number, fallbackPos: number): void {
  // Looked up in the live doc: a list can be up to the debounce stale.
  const pos = readNoteStats(editor.state.doc).outline[index]?.pos ?? fallbackPos;
  editor
    .chain()
    .focus()
    .setTextSelection(Math.min(pos + 1, editor.state.doc.content.size))
    .scrollIntoView()
    .run();
}

/** The note's stats, re-read a moment after each edit. */
export function useNoteStats(editor: Editor): NoteStats {
  const [stats, setStats] = useState(() => readNoteStats(editor.state.doc));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        setStats(readNoteStats(editor.state.doc));
      }, DEBOUNCE_MS);
    };
    editor.on('update', update);
    return () => {
      clearTimeout(timer);
      editor.off('update', update);
    };
  }, [editor]);
  return stats;
}

export function NoteStatsFooter({
  editor,
  className = 'px-5 py-1 sm:px-8',
  showWords = true,
}: {
  readonly editor: Editor;
  readonly className?: string;
  /** False while the status bar already shows the word count. */
  readonly showWords?: boolean;
}): ReactNode {
  const stats = useNoteStats(editor);

  return (
    <div className={`flex shrink-0 items-center gap-3 ${className}`}>
      {showWords ? (
        <Text variant="caption" tone="muted">
          {stats.words} {stats.words === 1 ? 'word' : 'words'} · {stats.minutes} min read
        </Text>
      ) : null}
      <Popover
        label="Outline"
        trigger={(trigger) => (
          <Button variant="subtle" className="shrink-0 whitespace-nowrap" {...trigger}>
            Outline
          </Button>
        )}
      >
        {({ close }) =>
          stats.outline.length === 0 ? (
            <Text variant="caption" tone="muted">
              No headings yet.
            </Text>
          ) : (
            <ul className="flex max-h-72 flex-col overflow-y-auto">
              {stats.outline.map((entry, index) => (
                <li key={entry.pos} className={OUTLINE_INDENT[entry.level - 1] ?? 'pl-15'}>
                  <Button
                    variant="subtle"
                    className="w-full justify-start"
                    onClick={() => {
                      close();
                      jumpToHeading(editor, index, entry.pos);
                    }}
                  >
                    {entry.text || 'Untitled heading'}
                  </Button>
                </li>
              ))}
            </ul>
          )
        }
      </Popover>
    </div>
  );
}
