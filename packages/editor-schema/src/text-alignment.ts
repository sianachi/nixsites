import { Extension } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';

export const TEXT_ALIGNMENTS = ['left', 'center', 'right'] as const;
export type TextAlignment = (typeof TEXT_ALIGNMENTS)[number];
const ALIGNED_TEXT_BLOCKS = ['paragraph', 'heading', 'detailsSummary'] as const;

/** Unknown values stay in the document, but never become arbitrary CSS. */
export function readTextAlignment(value: unknown): TextAlignment | null {
  return value === 'left' || value === 'center' || value === 'right' ? value : null;
}

export const TextAlignmentAttributes = Extension.create({
  name: 'textAlignmentAttributes',
  addGlobalAttributes() {
    return [
      {
        types: [...ALIGNED_TEXT_BLOCKS],
        attributes: {
          textAlign: {
            default: null,
            parseHTML: (element) => readTextAlignment(element.style.textAlign),
            renderHTML: (attributes) => {
              const alignment = readTextAlignment(attributes.textAlign);
              return alignment === null ? {} : { style: `text-align: ${alignment}` };
            },
          },
        },
      },
    ];
  },
});

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    textAlignment: {
      setTextAlign: (alignment: TextAlignment) => ReturnType;
    };
  }
}

/** One transaction aligns all selected text blocks, including blocks in table cells. */
export const TextAlignmentEditing = Extension.create({
  name: 'textAlignmentEditing',
  addCommands() {
    return {
      setTextAlign:
        (alignment: TextAlignment) =>
        ({ tr, dispatch }) => {
          return setTextAlignTr(tr, alignment, dispatch !== undefined);
        },
    };
  },
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-l': () => this.editor.commands.setTextAlign('left'),
      'Mod-Shift-e': () => this.editor.commands.setTextAlign('center'),
      'Mod-Shift-r': () => this.editor.commands.setTextAlign('right'),
    };
  },
});

export function setTextAlignTr(tr: Transaction, alignment: TextAlignment, apply: boolean): boolean {
  if (readTextAlignment(alignment) === null) return false;
  let applicable = false;
  const visited = new Set<number>();
  for (const range of tr.selection.ranges) {
    tr.doc.nodesBetween(range.$from.pos, range.$to.pos, (node, position) => {
      if (!ALIGNED_TEXT_BLOCKS.some((name) => name === node.type.name)) return;
      applicable = true;
      if (apply && !visited.has(position)) {
        tr.setNodeMarkup(position, undefined, { ...node.attrs, textAlign: alignment });
        visited.add(position);
      }
    });
  }
  return applicable;
}
