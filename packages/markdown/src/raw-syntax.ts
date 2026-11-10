/**
 * Markdown syntax that survived conversion as literal text outside code. The counts tell a model
 * (and the approval card) that a rewrite is needed; they hold kinds and numbers only, never note
 * text.
 */

interface RawNode {
  type: string;
  content?: RawNode[];
  text?: string;
  marks?: { type: string }[];
}

const PATTERNS: readonly (readonly [kind: string, pattern: RegExp])[] = [
  ['bold-marker', /\*\*(?=\S)|(?<=\S)\*\*/g],
  [
    'html-tag',
    /<\/?(?:a|b|i|u|p|br|hr|div|span|em|strong|code|pre|img|ul|ol|li|table|tr|td|th|h[1-6]|sup|sub|mark|details|summary|blockquote|del|s|kbd|small|iframe|script|style)(?:\s[^>]*)?\/?>/gi,
  ],
  ['math', /\$[^\s$\d](?:[^$]*[^\s$])?\$/g],
  ['highlight', /(?<!\w)==[^=\s](?:[^=]*[^=\s])?==(?!\w)/g],
  ['footnote', /\[\^[^\]\s]+\]/g],
];

/** Counts leftover syntax by kind. Empty when the document is clean. */
export function countRawSyntax(doc: RawNode): Record<string, number> {
  const found: Record<string, number> = {};
  const add = (kind: string, n: number): void => {
    if (n > 0) found[kind] = (found[kind] ?? 0) + n;
  };
  const visit = (node: RawNode): void => {
    if (node.type === 'codeBlock') return;
    if (node.type === 'text') {
      if (node.marks?.some((mark) => mark.type === 'code') || node.text === undefined) return;
      const text = node.text;
      for (const [kind, pattern] of PATTERNS) add(kind, text.match(pattern)?.length ?? 0);
      return;
    }
    node.content?.forEach(visit);
  };
  visit(doc);
  return found;
}
