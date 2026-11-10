/**
 * Clean-up for Markdown a model wrote, before it is parsed. Used by the pet's note writes, chat
 * rendering and inline apply only; an imported file is the author's Markdown and is taken as written.
 */

const WHOLE_FENCE = /^\s*(`{3,}|~{3,})[ \t]*(?:markdown|md)[ \t]*\n([\s\S]*)\n[ \t]*\1[ \t]*\s*$/i;
const FENCE_LINE = /^\s*(`{3,}|~{3,})/;
const LIST_OR_TABLE = /^\s{0,3}(?:[-*+]\s|\d{1,9}[.)]\s|\|)/;
// A line that is already a block of its own, or part of one, and so needs no blank line after it.
const NOT_PARAGRAPH = /^(?:\s|[-*+]\s|\d{1,9}[.)]\s|\||#|>|`{3,}|~{3,}|-{3,}\s*$|\*{3,}\s*$)/;

/** True when no line of the fenced body closes the opener early, so the fence really is the whole text. */
function closesOnlyAtEnd(opener: string, body: string): boolean {
  return !body.split('\n').some((line) => {
    const t = line.trim();
    return t.length >= opener.length && t.startsWith(opener[0] ?? '') && /^(.)\1*$/.test(t);
  });
}

/**
 * Unwrap a ```markdown or ```md fence that is the entire text, and put a blank line before a list
 * or table that directly follows a paragraph line (CommonMark merges `2. x` into the paragraph above
 * it). Text inside code fences is never touched.
 */
export function cleanModelMarkdown(text: string): string {
  const body = WHOLE_FENCE.exec(text);
  const unwrapped =
    body !== null && closesOnlyAtEnd(body[1] ?? '', body[2] ?? '') ? (body[2] ?? '') : text;
  const lines = unwrapped.split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const marker = FENCE_LINE.exec(line)?.[1];
    if (fence !== null) {
      if (
        marker !== undefined &&
        marker.startsWith(fence[0] ?? '') &&
        marker.length >= fence.length
      ) {
        fence = null;
      }
    } else if (marker !== undefined) {
      fence = marker;
    } else if (LIST_OR_TABLE.test(line)) {
      const previous = out.at(-1);
      if (previous !== undefined && previous.trim() !== '' && !NOT_PARAGRAPH.test(previous)) {
        out.push('');
      }
    }
    out.push(line);
  }
  return out.join('\n');
}
