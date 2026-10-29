import { Extension, Mark, mergeAttributes } from '@tiptap/core';

/** Block nodes that can carry a whole-block suggestion. */
export const SUGGESTIBLE_BLOCKS = [
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'callout',
  'image',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'table',
  'columnBlock',
  'details',
  'itemBlock',
  'pageBreak',
];

/** A block-level suggestion: who proposed it, and what kind of change it is. */
export interface BlockSuggestion {
  id: string;
  authorId: string;
  createdAt: string;
  op: 'insert' | 'delete' | 'restructure';
  /** For `restructure`: the JSON of the range it replaced. */
  before?: string;
}

/** The stored value, or null for anything that is not a suggestion object. */
export function readBlockSuggestion(value: unknown): BlockSuggestion | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as BlockSuggestion)
    : null;
}

/** Version 7. Carries a block-level suggestion as `data-suggestion` JSON. */
export const SuggestionAttributes = Extension.create({
  name: 'suggestionAttributes',
  addGlobalAttributes() {
    return [
      {
        types: SUGGESTIBLE_BLOCKS,
        attributes: {
          suggestion: {
            default: null,
            parseHTML: (element) => {
              const raw = element.getAttribute('data-suggestion');
              if (raw === null) return null;
              try {
                return readBlockSuggestion(JSON.parse(raw));
              } catch {
                return null;
              }
            },
            renderHTML: (attributes) =>
              readBlockSuggestion(attributes.suggestion) === null
                ? {}
                : { 'data-suggestion': JSON.stringify(attributes.suggestion) },
          },
        },
      },
    ];
  },
});

function suggestionMark(name: string, tag: string, dataAttribute: string, extra: string[] = []) {
  const keys = ['id', 'authorId', 'createdAt', ...extra];
  return Mark.create({
    name,
    inclusive: false,
    addAttributes() {
      return Object.fromEntries(
        keys.map((key) => [
          key,
          {
            default: null,
            parseHTML: (element: HTMLElement) => element.getAttribute(`data-suggestion-${key}`),
            renderHTML: (attributes: Record<string, unknown>) => {
              const value = attributes[key];
              return typeof value === 'string' ? { [`data-suggestion-${key}`]: value } : {};
            },
          },
        ]),
      );
    },
    parseHTML() {
      return [{ tag: `${tag}[${dataAttribute}]` }];
    },
    renderHTML({ HTMLAttributes }) {
      return [tag, mergeAttributes(HTMLAttributes, { [dataAttribute]: '' }), 0];
    },
  });
}

/** Version 7. Text proposed by a suggestion. */
export const SuggestionInsertMark = suggestionMark('suggestionInsert', 'ins', 'data-suggestion');

/** Version 7. Text a suggestion proposes to remove; it stays in the document until accepted. */
export const SuggestionDeleteMark = suggestionMark('suggestionDelete', 'del', 'data-suggestion');

/** Version 7. A formatting change; `before` is the JSON of the mark set it replaced. */
export const SuggestionFormatMark = suggestionMark(
  'suggestionFormat',
  'span',
  'data-suggestion-format',
  ['before'],
);
