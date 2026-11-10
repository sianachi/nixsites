import { markdownToDocument } from '@nix/markdown';
import { READ_ONLY_OPERATIONS, type WorkspaceToolArgs } from './tool-args.js';

/** Writes that keep asking even while "apply changes without asking" is on. Each one can
 * change who sees something, which no preview makes safe to run unread and no undo takes
 * back. Existing view refinements also always require a review of the before/after card.
 * Trash hides an item from everyone until restored; a move changes which ancestors an
 * item inherits its permissions from, so it can widen the audience; a template capture copies
 * a subtree into the workspace-visible library. A generic action (publish, permanent delete,
 * sharing, approving or revoking a file version, creating a public link) can do all of that, so it
 * never applies unattended: those operations are only reachable through `run_action`. */
const ALWAYS_ASK_OPERATIONS: ReadonlySet<WorkspaceToolArgs['operation']> = new Set<
  WorkspaceToolArgs['operation']
>(['trash_item', 'move_item', 'save_as_template', 'update_view', 'edit_fields', 'run_action']);

/** Whether a pending write may run without a click once its preview has loaded clean. Reads
 * are governed separately (`readWithoutAsking`); this only answers for writes. Lives in this
 * package rather than the web app so the eval harness
 * applies the same rule when it is built. A preview with problems, no preview at all, and text with an
 * external link (`hasExternalLink`) are the caller's own checks: this function only knows the
 * operation. */
export function canApplyWithoutAsking(operation: WorkspaceToolArgs['operation']): boolean {
  return !READ_ONLY_OPERATIONS.has(operation) && !ALWAYS_ASK_OPERATIONS.has(operation);
}

const EXTERNAL_LINK = /(?:^|[^A-Za-z0-9])(?:(?:https?|ftp):[\\/]*|[\\/]{2})[^\s/\\]+/i;

/** Every link href and image src the text would store, read from the converted document. */
function storedUrls(node: unknown, out: string[]): string[] {
  if (node === null || typeof node !== 'object') return out;
  const record = node as {
    attrs?: Record<string, unknown>;
    marks?: unknown[];
    content?: unknown[];
  };
  for (const key of ['href', 'src']) {
    const value = record.attrs?.[key];
    if (typeof value === 'string') out.push(value);
  }
  record.marks?.forEach((mark) => storedUrls(mark, out));
  record.content?.forEach((child) => storedUrls(child, out));
  return out;
}

// The converter decodes entities (https&#58;host), so the raw-text test must see the decoded form.
const decodeNumericEntities = (text: string): string =>
  text.replaceAll(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_match, hex?: string, dec?: string) =>
    String.fromCodePoint(hex === undefined ? Number(dec) : Number.parseInt(hex, 16)),
  );

const isOffSite = (value: string): boolean => {
  try {
    return new URL(value, 'https://nix.invalid').host !== 'nix.invalid';
  } catch {
    return true;
  }
};

/** Whether any text a write would store carries a link to another host. ADR-0050 Amendment 1
 * accepted unattended reads because every write was still read by the owner on a never-folded
 * card; with writes unattended too, injected text could make the model store an image or link
 * whose URL carries what it just read, and the browser would fetch it the first time anyone
 * opens the item. Such a write always waits for the owner. */
export function hasExternalLink(texts: readonly string[]): boolean {
  return texts.some(
    (text) =>
      EXTERNAL_LINK.test(text) ||
      storedUrls(markdownToDocument(text), []).some(isOffSite) ||
      EXTERNAL_LINK.test(decodeNumericEntities(text)),
  );
}

/** Operations only the app can run: `remember` depends on the synced memory mode and
 * `save_as_template` on the app's build ledger. A server-side executor leaves them to the app. */
export const APP_ONLY_OPERATIONS: ReadonlySet<WorkspaceToolArgs['operation']> = new Set<
  WorkspaceToolArgs['operation']
>(['remember', 'save_as_template']);

export const BODY_EDIT_OPERATIONS: ReadonlySet<WorkspaceToolArgs['operation']> = new Set([
  'replace_section',
  'replace_passage',
]);

/** One piece of text a pending write would store, with a human label derived from where it sits
 * in the parsed request (security fix S1). */
export interface WriteTextItem {
  label: string;
  text: string;
}

const WRITE_TEXT_ARRAY_NOUNS: Record<string, string> = {
  entries: 'Entry',
  fields: 'Field',
  inputs: 'Input',
  pages: 'Page',
  blocks: 'Question',
  views: 'View',
  rules: 'Rule',
};

const WRITE_TEXT_KEY_WORDS: Record<string, string> = {
  markdown: 'body',
  body: 'body',
  help: 'help',
  description: 'description',
  message: 'confirmation message',
  paragraph: 'paragraph',
  heading: 'heading',
  formula: 'formula',
  why: 'why',
  default: 'default',
  title: 'title',
  label: 'label',
  value: 'value',
  query: 'query',
};

function writeTextWord(key: string): string {
  return WRITE_TEXT_KEY_WORDS[key] ?? key.replaceAll(/([A-Z])/g, ' $1').toLowerCase();
}

/** The `label`/`title`/`field`/`heading` a spec array item names itself by, so a nested string
 * (a field's help, a question's confirmation copy) can be labelled by what it belongs to rather
 * than by its position alone. */
function writeTextItemName(record: Record<string, unknown>): string | undefined {
  for (const key of ['label', 'title', 'field', 'heading']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

/** Walks a parsed spec (or the property values of a `set_properties` request) and collects every
 * non-empty string value in it, each with a plain-language label built from its path - "Entry 3
 * body", "Field help: Status" - falling back to a capitalized key name. Security fix S1: nothing
 * a pending write would store may stay off this list, so every string leaf is collected, not just
 * the ones a specific operation is known to care about. */
function collectWriteText(
  value: unknown,
  key: string | undefined,
  arrayNoun: string | undefined,
  itemName: string | undefined,
  out: WriteTextItem[],
): void {
  if (typeof value === 'string') {
    if (!value.trim() || key === undefined) return;
    const word = writeTextWord(key);
    const label =
      itemName !== undefined
        ? `${arrayNoun ?? 'Item'} ${word}: ${itemName}`
        : word.charAt(0).toUpperCase() + word.slice(1);
    out.push({ label, text: value });
    return;
  }
  if (Array.isArray(value)) {
    const noun = key !== undefined ? WRITE_TEXT_ARRAY_NOUNS[key] : undefined;
    value.forEach((item) => {
      const name =
        item !== null && typeof item === 'object' && !Array.isArray(item)
          ? writeTextItemName(item as Record<string, unknown>)
          : undefined;
      collectWriteText(item, undefined, noun, name, out);
    });
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      collectWriteText(nestedValue, nestedKey, arrayNoun, itemName, out);
    }
  }
}

const WRITE_TEXT_SPEC_OPERATIONS: ReadonlySet<WorkspaceToolArgs['operation']> = new Set([
  'create_structured',
  'add_view',
  'create_entries',
  'add_fields',
  'edit_fields',
  'edit_form',
  'set_recurrence',
  'apply_template',
  'build_blueprint',
  'save_as_template',
  'run_action',
]);

/** Every piece of text a pending write would store, for the section that shows it in full before
 * Approve (security fix S1). */
// View refinements show every changed string in the complete before/after structure preview.
// Selection identities and field keys are not additional text the change writes.
export function writeTextItems(args: WorkspaceToolArgs): WriteTextItem[] {
  const out: WriteTextItem[] = [];
  if (WRITE_TEXT_SPEC_OPERATIONS.has(args.operation) && args.specJson.trim()) {
    try {
      const parsed: unknown = JSON.parse(args.specJson);
      collectWriteText(parsed, undefined, undefined, undefined, out);
    } catch {
      // Invalid JSON is already surfaced as a problem elsewhere; there is nothing to list here.
    }
  }
  if (args.operation === 'set_properties' && args.propertiesJson.trim()) {
    try {
      const parsed: unknown = JSON.parse(args.propertiesJson);
      collectWriteText(parsed, undefined, undefined, undefined, out);
    } catch {
      // ditto
    }
  }
  if (args.markdown.trim()) {
    out.push({
      label:
        args.operation === 'append_note'
          ? 'Added note text'
          : args.operation === 'replace_section'
            ? 'New section text'
            : args.operation === 'replace_passage'
              ? 'Replacement text'
              : 'Note body',
      text: args.markdown,
    });
  }
  return out;
}

/** What the server re-checks for an automatic approval: the parts of `writeMayRunWithoutAsking`
 * that depend on the arguments and the conversation alone. Preview-derived conditions (a body
 * edit's joined text, lost formatting, a repeating-task occurrence) are pinned by the fence the
 * app's preview produced; the executor refuses when it no longer matches. */
export function mayApplyUnasked(args: WorkspaceToolArgs, lockedRead: boolean): boolean {
  return (
    canApplyWithoutAsking(args.operation) &&
    !lockedRead &&
    !hasExternalLink([args.title, ...writeTextItems(args).map((item) => item.text)])
  );
}
