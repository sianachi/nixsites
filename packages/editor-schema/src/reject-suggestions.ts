/**
 * A document body as it reads with every suggestion rejected, as pure JSON in and JSON out.
 *
 * Exports, the site renderer and the Markdown writer draw the document as it stood before anyone
 * proposed a change: inserted text and blocks go, deleted text and blocks stay, a format change
 * goes back to its `before` marks, and a restructure goes back to its snapshot.
 */

type Json = Record<string, unknown>;

const TEXTBLOCKS = new Set(['paragraph', 'heading', 'codeBlock', 'detailsSummary']);

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function suggestionOf(node: Json): Json | null {
  const attrs = node.attrs;
  return isRecord(attrs) && isRecord(attrs.suggestion) ? attrs.suggestion : null;
}

/** A text node with its suggestion marks resolved; null when the text was a proposed insert. */
function rejectText(node: Json): Json | null {
  const marks = Array.isArray(node.marks) ? node.marks.filter(isRecord) : [];
  if (marks.some((mark) => mark.type === 'suggestionInsert')) return null;
  const format = marks.find((mark) => mark.type === 'suggestionFormat');
  if (format === undefined && !marks.some((mark) => mark.type === 'suggestionDelete')) return node;
  const before = parseJson(isRecord(format?.attrs) ? format.attrs.before : null);
  const kept = Array.isArray(before)
    ? before
    : marks.filter((mark) => mark.type !== 'suggestionDelete' && mark.type !== 'suggestionFormat');
  const rest: Json = { ...node };
  delete rest.marks;
  return kept.length === 0 ? rest : { ...rest, marks: kept };
}

function hasText(node: Json): boolean {
  return (
    node.type === 'text' ||
    (Array.isArray(node.content) && node.content.some((child) => isRecord(child) && hasText(child)))
  );
}

/** Appends `node`, joining it to a text node before it that has the same marks. */
function push(out: unknown[], node: unknown): void {
  const last = out[out.length - 1];
  if (
    isRecord(node) &&
    node.type === 'text' &&
    isRecord(last) &&
    last.type === 'text' &&
    JSON.stringify(last.marks) === JSON.stringify(node.marks)
  ) {
    out[out.length - 1] = { ...last, text: `${String(last.text)}${String(node.text)}` };
    return;
  }
  out.push(node);
}

/** Moves the text a split block still holds onto the block before it. */
function mergeInto(previous: Json, node: Json): boolean {
  if (!Array.isArray(previous.content) || !Array.isArray(node.content)) return false;
  const before = previous.content as unknown[];
  const after = node.content as unknown[];
  if (TEXTBLOCKS.has(String(previous.type)) && TEXTBLOCKS.has(String(node.type))) {
    const content: unknown[] = [];
    for (const child of [...before, ...after]) push(content, child);
    previous.content = content;
    return true;
  }
  const last = before[before.length - 1];
  const [first, ...rest] = after;
  if (!isRecord(last) || !isRecord(first)) return false;
  const merged = { ...last };
  if (!mergeInto(merged, first)) return false;
  previous.content = [...before.slice(0, -1), merged, ...rest];
  return true;
}

function rejectChildren(children: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (!isRecord(child)) {
      out.push(child);
      continue;
    }
    if (child.type === 'text') {
      const text = rejectText(child);
      if (text !== null) push(out, text);
      continue;
    }
    const suggestion = suggestionOf(child);
    const snapshot = suggestion?.op === 'restructure' ? parseJson(suggestion.before) : null;
    if (suggestion !== null && isRecord(snapshot) && Array.isArray(snapshot.content)) {
      // The run of blocks one restructure produced is replaced by what it replaced. An open
      // snapshot cannot be placed without the surrounding blocks, so it keeps the new structure.
      if (!snapshot.openStart && !snapshot.openEnd) {
        while (i + 1 < children.length) {
          const next = children[i + 1];
          if (!isRecord(next) || suggestionOf(next)?.id !== suggestion.id) break;
          i += 1;
        }
        out.push(...rejectChildren(snapshot.content));
        continue;
      }
    }
    const rejected = rejectNode(child);
    if (suggestion?.op !== 'insert') {
      out.push(rejected);
    } else if (hasText(rejected)) {
      const previous = out[out.length - 1];
      if (!isRecord(previous) || !mergeInto(previous, rejected)) out.push(rejected);
    }
  }
  return out;
}

function rejectNode(node: Json): Json {
  const { content, attrs, ...rest } = node;
  const result: Json = { ...rest };
  if (isRecord(attrs)) {
    const others: Json = { ...attrs };
    delete others.suggestion;
    result.attrs = others;
  }
  if (Array.isArray(content)) result.content = rejectChildren(content);
  return result;
}

/** The document with every suggestion rejected; anything that is not a node is returned as given. */
export function rejectAllSuggestions(doc: unknown): unknown {
  return isRecord(doc) ? rejectNode(doc) : doc;
}
