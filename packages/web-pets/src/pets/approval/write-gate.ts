import { canApplyWithoutAsking, hasExternalLink } from '@nix/companion/auto-apply';
import type { WorkspaceToolArgs } from '@nix/companion/tool-args';
import type { PreviewModel } from '@nix/structure-spec';

/* The rules every approval card applies, from the pet's tool cards and from components' writes
 * alike (moved unchanged from pet-work-tools.tsx, where their history and the security fixes they
 * carry are recorded): when "Apply without asking" may cover a write, why one waits anyway, and
 * every string a write would store (security fix S1). */

/** Whether the switch may ever cover this write: the operation is allowed and none of the text
 * it would store links to another host (see `hasExternalLink`). The title is included because
 * `writeTextItems` lists only bodies, specs and property values. A note body edit also passes the
 * edited block as it will read afterwards (`model.bodyEdit.after`): the find and replace text can
 * join with what is already there into a link neither holds alone. An edit that would drop
 * formatting Markdown cannot carry always waits, so the owner sees the loss before it happens,
 * and so does completing an occurrence of a repeating task (`taskOccurrence`), which cannot be
 * undone. */
export function writeMayRunWithoutAsking(
  args: WorkspaceToolArgs,
  model?: PreviewModel,
  taskOccurrence = false,
): boolean {
  return (
    canApplyWithoutAsking(args.operation) &&
    // Completing an occurrence of a repeating task cannot be undone (Core has no reopen).
    !taskOccurrence &&
    // A body edit's stored text is only known once its preview has placed it.
    (!BODY_EDIT_OPERATIONS.has(args.operation) || model?.bodyEdit !== undefined) &&
    model?.bodyEdit?.losesFormatting !== true &&
    !hasExternalLink([
      args.title,
      ...writeTextItems(args).map((item) => item.text),
      ...(model?.bodyEdit ? [model.bodyEdit.after] : []),
    ])
  );
}

/** Note body edits show the whole edited block before and after (`PetBodyEditPreview`), which
 * already includes every character the request would store. */
const WAITS_FOR_FORMATTING =
  'This one waits for you: approving it removes formatting this edit can’t keep (see below).';
const WAITS_FOR_LINK = 'This one waits for you: it adds a link to another site.';
export const HELD_AFTER_LOCKED_READ =
  'This one waits for you: earlier reads need your review before changes.';
const HELD_FOR_OCCURRENCE =
  "This one waits for you: completing a repeating task's occurrence cannot be undone.";

/** Why a write the owner's switch would otherwise run is waiting anyway, in the owner's words,
 * when that is something the preview shows: formatting a body edit drops, or a link to another
 * host in what it would store. */
export function waitsForOwnerBecause(
  args: WorkspaceToolArgs,
  model: PreviewModel,
  taskOccurrence = false,
): string | undefined {
  if (taskOccurrence) return HELD_FOR_OCCURRENCE;
  if (model.bodyEdit?.losesFormatting) return WAITS_FOR_FORMATTING;
  if (
    hasExternalLink([
      args.title,
      ...writeTextItems(args).map((item) => item.text),
      ...(model.bodyEdit ? [model.bodyEdit.after] : []),
    ])
  )
    return WAITS_FOR_LINK;
  return undefined;
}

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
