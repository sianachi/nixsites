import { companionBodies, type NixClient } from '@nix/api-client';
import { nixSchema } from '@nix/editor-schema';
import {
  documentToMarkdown,
  EMPTY_MARKDOWN_IMPORT_SCAN,
  cleanModelMarkdown,
  markdownToDocument,
  type MarkdownLoss,
} from '@nix/markdown';
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import * as Y from 'yjs';
import type { PreviewTextRange } from '@nix/structure-spec';
import type { BodyEdit, BodyEditPlan, CompanionBodies } from './ports.js';
import { WorkspaceToolRefusal } from './tool-args.js';

/** A ProseMirror node as `toJSON()` writes it. */
interface NodeJson {
  type: string;
  attrs?: Record<string, unknown>;
  content?: NodeJson[];
  text?: string;
}

/** One block an edit may replace, paired with the Yjs element that stores it. */
interface Located {
  json: NodeJson;
  parent: Y.XmlFragment | Y.XmlElement;
  index: number;
}

/** An edit placed against one loaded note: which run of a parent's children it removes, which
 * blocks it inserts in their place, and the plan reported to the caller. */
interface Placement {
  parent: Y.XmlFragment | Y.XmlElement;
  index: number;
  removeCount: number;
  blocks: NodeJson[];
  plan: BodyEditPlan;
}

const MAX_LISTED_HEADINGS = 20;

/** Refuses with the model's text (which may name tools) and the owner's (which never does). */
function refuse(model: string, owner: string): WorkspaceToolRefusal {
  return new WorkspaceToolRefusal(model, owner);
}

function unsafe(): WorkspaceToolRefusal {
  return refuse(
    'This note has content the companion cannot edit safely. No change was made; use nix_append_note instead.',
    'This note has content the pet cannot edit safely, so nothing was edited.',
  );
}

/** The kind of block a passage sits in, as the owner would name it. */
function passageScope(block: Located): BodyEditPlan['scope'] {
  if (block.json.type === 'heading') return 'heading';
  if (block.json.type === 'codeBlock') return 'code block';
  const container = block.parent instanceof Y.XmlElement ? block.parent.nodeName : '';
  if (container === 'listItem' || container === 'taskItem') return 'list item';
  if (container === 'tableCell' || container === 'tableHeader') return 'table cell';
  return 'paragraph';
}

/** The characters that differ between `before` and `after`, found by trimming what both start
 * and end with: the edited passage once the Markdown round trip has normalised both sides. */
function changedRanges(
  before: string,
  after: string,
): { beforeRange: PreviewTextRange; afterRange: PreviewTextRange } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let tail = 0;
  while (
    tail < before.length - start &&
    tail < after.length - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++;
  return {
    beforeRange: { start, end: before.length - tail },
    afterRange: { start, end: after.length - tail },
  };
}

function render(blocks: readonly NodeJson[]): { markdown: string; losses: MarkdownLoss[] } {
  const result = documentToMarkdown({ type: 'doc', content: blocks });
  return { markdown: result.markdown.trim(), losses: [...result.losses] };
}

function textOf(node: NodeJson): string {
  return node.text ?? (node.content ?? []).map(textOf).join('');
}

function normalizeHeading(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function headingLevel(node: NodeJson): number | undefined {
  if (node.type !== 'heading') return undefined;
  const level = node.attrs?.level;
  return typeof level === 'number' ? level : 1;
}

/** Tells the model when syntax stayed literal text, so it can rewrite instead of reporting success.
 * Kinds and counts only, never note text. */
function rawNote(scan: BodyEditPlan['markdownChanges']): { rawSyntaxNote?: string } {
  const kinds = Object.entries(scan.rawSyntax ?? {});
  if (kinds.length === 0) return {};
  const list = kinds.map(([kind, count]) => `${kind} x${String(count)}`).join(', ');
  return {
    rawSyntaxNote: `Some Markdown stayed as plain text in the note (${list}). Rewrite those places with supported Markdown.`,
  };
}

function parseBlocks(
  markdown: string,
  clean = true,
): {
  blocks: NodeJson[];
  scan: BodyEditPlan['markdownChanges'];
} {
  if (markdown.length > 16000)
    throw refuse(
      'Provide up to 16,000 characters of Markdown.',
      'The new text is too long, so nothing was edited.',
    );
  const parsed = markdownToDocument(clean ? cleanModelMarkdown(markdown) : markdown);
  if (!parsed.ok)
    throw refuse(
      'The proposed Markdown is invalid.',
      'The new text could not be read as Markdown, so nothing was edited.',
    );
  return { blocks: (parsed.doc as NodeJson).content ?? [], scan: parsed.scan };
}

/** Pairs each Yjs child of `parent` with its ProseMirror JSON. The two must agree node for node
 * (y-prosemirror skips a node it cannot read); when they do not, nothing is edited, because an
 * index into one would not be an index into the other. */
function pair(parent: Y.XmlFragment | Y.XmlElement, json: readonly NodeJson[]): Y.XmlElement[] {
  const children = parent.toArray();
  if (children.length !== json.length) throw unsafe();
  return children.map((child, index) => {
    if (!(child instanceof Y.XmlElement) || child.nodeName !== json[index]?.type) throw unsafe();
    return child;
  });
}

function rootJson(fragment: Y.XmlFragment): NodeJson {
  return yXmlFragmentToProseMirrorRootNode(fragment, nixSchema).toJSON() as NodeJson;
}

/** Every textblock (paragraph, heading, code block, details summary) in the note, however deeply
 * it is nested, in document order. */
function textblocks(fragment: Y.XmlFragment): Located[] {
  const out: Located[] = [];
  const walk = (parent: Y.XmlFragment | Y.XmlElement, json: readonly NodeJson[]) => {
    const elements = pair(parent, json);
    json.forEach((node, index) => {
      const element = elements[index];
      const type = nixSchema.nodes[node.type];
      if (type === undefined || element === undefined) throw unsafe();
      if (type.isTextblock) out.push({ json: node, parent, index });
      else if (!type.isLeaf && !type.inlineContent) walk(element, node.content ?? []);
    });
  };
  walk(fragment, rootJson(fragment).content ?? []);
  return out;
}

function countOccurrences(text: string, find: string): number {
  let count = 0;
  for (let at = text.indexOf(find); at !== -1; at = text.indexOf(find, at + find.length)) count++;
  return count;
}

function placeSection(
  fragment: Y.XmlFragment,
  edit: Extract<BodyEdit, { kind: 'section' }>,
): Placement {
  const wanted = normalizeHeading(edit.heading.replace(/^\s*#{1,6}\s+/, ''));
  if (!wanted)
    throw refuse(
      'Name the heading of the section to replace.',
      'No heading was named, so nothing was edited.',
    );
  const json = rootJson(fragment).content ?? [];
  pair(fragment, json);
  const headings = json
    .map((node, index) => ({ node, index, level: headingLevel(node) }))
    .filter(
      (entry): entry is { node: NodeJson; index: number; level: number } =>
        entry.level !== undefined,
    );
  const matches = headings.filter((entry) => normalizeHeading(textOf(entry.node)) === wanted);
  if (matches.length === 0) {
    const names = headings.slice(0, MAX_LISTED_HEADINGS).map((entry) => `"${textOf(entry.node)}"`);
    throw refuse(
      names.length === 0
        ? `No heading "${edit.heading}" was found: this note has no headings. Use nix_replace_passage or nix_append_note instead.`
        : `No heading "${edit.heading}" was found. Headings in this note: ${names.join(', ')}${headings.length > MAX_LISTED_HEADINGS ? ', ...' : ''}.`,
      `There is no heading “${edit.heading}” in this note, so nothing was edited.`,
    );
  }
  if (matches.length > 1) {
    const described = matches.map((match) => {
      const above = headings
        .filter((entry) => entry.index < match.index && entry.level < match.level)
        .at(-1);
      return `level ${String(match.level)}${above ? ` under "${textOf(above.node)}"` : ' at the top'}`;
    });
    throw refuse(
      `The heading "${edit.heading}" appears ${String(matches.length)} times (${described.join('; ')}). Ask the owner which one, or change text inside it with nix_replace_passage.`,
      `The heading “${edit.heading}” appears ${String(matches.length)} times in this note, so the pet could not tell which section to change. Nothing was edited.`,
    );
  }
  const match = matches[0] as { node: NodeJson; index: number; level: number };
  let end = json.length;
  for (const entry of headings)
    if (entry.index > match.index && entry.level <= match.level) {
      end = entry.index;
      break;
    }
  if (!edit.markdown.trim())
    throw refuse(
      'Provide the new Markdown for the section.',
      'No new text was given for the section, so nothing was edited.',
    );
  const parsed = parseBlocks(edit.markdown);
  const keepHeading = parsed.blocks[0]?.type !== 'heading';
  const start = keepHeading ? match.index + 1 : match.index;
  const removed = render(json.slice(start, end));
  const before = render(json.slice(match.index, end)).markdown;
  const after = render(keepHeading ? [match.node, ...parsed.blocks] : parsed.blocks).markdown;
  return {
    parent: fragment,
    index: start,
    removeCount: end - start,
    blocks: parsed.blocks,
    plan: {
      scope: 'section',
      before,
      after,
      blocksRemoved: end - start,
      blocksAdded: parsed.blocks.length,
      losses: removed.losses,
      markdownChanges: parsed.scan,
      fingerprint: JSON.stringify(['section', before]),
    },
  };
}

function placePassage(
  fragment: Y.XmlFragment,
  edit: Extract<BodyEdit, { kind: 'passage' }>,
): Placement {
  if (!edit.find)
    throw refuse('Name the text to replace.', 'No text to find was given, so nothing was edited.');
  const rendered = textblocks(fragment).map((block) => ({ block, ...render([block.json]) }));
  const hits = rendered.filter((entry) => entry.markdown.includes(edit.find));
  const total = hits.reduce((sum, entry) => sum + countOccurrences(entry.markdown, edit.find), 0);
  if (total === 0)
    throw refuse(
      `"${edit.find}" was not found inside any one paragraph, heading, list item or code block. Copy the text exactly from nix_read_note, without list markers, and keep it inside one block.`,
      `“${edit.find}” is not in this note as one passage, so nothing was edited.`,
    );
  if (total > 1)
    throw refuse(
      `"${edit.find}" appears ${String(total)} times. Include more of the surrounding text so it matches exactly once.`,
      `“${edit.find}” appears ${String(total)} times in this note, so the pet could not tell which one to change. Nothing was edited.`,
    );
  const [hit] = hits;
  if (hit === undefined) throw unsafe();
  const at = hit.markdown.indexOf(edit.find);
  // Only the model's text is cleaned; the owner's own block is parsed as it rendered. Its raw
  // syntax is counted from the model's text alone, so existing text is never flagged for rewriting.
  const replace = edit.replace ? cleanModelMarkdown(edit.replace) : '';
  const next = hit.markdown.slice(0, at) + replace + hit.markdown.slice(at + edit.find.length);
  const parsed = next.trim()
    ? parseBlocks(next, false)
    : { blocks: [], scan: EMPTY_MARKDOWN_IMPORT_SCAN };
  if (replace.trim()) parsed.scan = parseBlocks(replace, false).scan;
  else parsed.scan = EMPTY_MARKDOWN_IMPORT_SCAN;
  const after = render(parsed.blocks).markdown;
  const nested = hit.block.parent !== fragment;
  if (nested && (parsed.blocks.length !== 1 || parsed.blocks[0]?.type !== hit.block.json.type))
    throw refuse(
      'That replacement would change the shape of the list, table or block the text sits in. Keep it to text inside the block, or rewrite the whole section with nix_replace_section.',
      'That change would reshape a list or table, so nothing was edited.',
    );
  return {
    parent: hit.block.parent,
    index: hit.block.index,
    removeCount: 1,
    blocks: parsed.blocks,
    plan: {
      scope: passageScope(hit.block),
      ...changedRanges(hit.markdown, after),
      before: hit.markdown,
      after,
      blocksRemoved: 1,
      blocksAdded: parsed.blocks.length,
      losses: hit.losses,
      markdownChanges: parsed.scan,
      fingerprint: JSON.stringify(['passage', hit.markdown]),
    },
  };
}

function place(fragment: Y.XmlFragment, edit: BodyEdit): Placement {
  return edit.kind === 'section' ? placeSection(fragment, edit) : placePassage(fragment, edit);
}

/** Yjs elements for `blocks`, built in a scratch document and cloned so they can be inserted
 * into the note's own document. */
function toElements(blocks: readonly NodeJson[]): (Y.XmlElement | Y.XmlText)[] {
  if (blocks.length === 0) return [];
  const scratch = new Y.Doc();
  try {
    const built = prosemirrorJSONToYXmlFragment(
      nixSchema,
      { type: 'doc', content: blocks },
      scratch.getXmlFragment('default'),
    );
    return built.toArray().map((node) => {
      if (!(node instanceof Y.XmlElement) && !(node instanceof Y.XmlText))
        throw new Error('Unsupported note block.');
      return node.clone();
    });
  } finally {
    scratch.destroy();
  }
}

/**
 * The note-body adapter. Every write here is block-granular: it never reserialises the owner's
 * rich content wholesale. `append` clones new blocks onto the end; `applyEdit` removes only the
 * blocks an edit names (a section's blocks, or the one block holding a passage) and inserts the
 * parsed replacement in their place, so every other block keeps its Yjs identity, its marks and
 * any concurrent edits made to it.
 */
export function createCompanionBodies(client: NixClient): CompanionBodies {
  async function load(itemId: string, signal: AbortSignal) {
    const doc = new Y.Doc();
    let after = '0';
    let bytes = 0;
    try {
      for (let count = 0; count < 64; count++) {
        const page = await client.query(companionBodies.bodyUpdates(itemId, after), {
          signal,
          forceRefresh: true,
        });
        for (const entry of page.updates) {
          bytes += entry.update.length;
          if (bytes > 4 * 1024 * 1024 || BigInt(entry.seq) <= BigInt(after))
            throw new Error('This note exceeds the companion reading limit.');
          Y.applyUpdate(
            doc,
            Uint8Array.from(atob(entry.update), (char) => char.charCodeAt(0)),
          );
          after = entry.seq;
        }
        if (!page.hasMore) return doc;
        if (!page.updates.length) throw new Error('The note history is incomplete.');
      }
      throw new Error('This note has too much history for the companion.');
    } catch (error) {
      doc.destroy();
      throw error;
    }
  }
  async function publish(
    itemId: string,
    doc: Y.Doc,
    before: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    const delta = Y.encodeStateAsUpdate(doc, before);
    let binary = '';
    for (const byte of delta) binary += String.fromCharCode(byte);
    await client.execute(
      companionBodies.appendBodyUpdate(itemId, btoa(binary), `pet-${crypto.randomUUID()}`),
      { signal },
    );
  }
  return {
    async read(itemId, signal) {
      const doc = await load(itemId, signal);
      try {
        const content = documentToMarkdown(
          yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment('default'), nixSchema).toJSON(),
        );
        return {
          markdown: content.markdown.slice(0, 14000),
          losses: content.losses,
          truncated: content.markdown.length > 14000,
        };
      } finally {
        doc.destroy();
      }
    },
    async append(itemId, markdown, signal) {
      if (!markdown.trim() || markdown.length > 16000)
        throw new Error('Provide up to 16,000 characters of Markdown.');
      const parsed = markdownToDocument(cleanModelMarkdown(markdown));
      if (!parsed.ok) throw new Error('The proposed Markdown is invalid.');
      const doc = await load(itemId, signal);
      const added = new Y.Doc();
      try {
        const fragment = doc.getXmlFragment('default');
        const incoming = prosemirrorJSONToYXmlFragment(
          nixSchema,
          parsed.doc,
          added.getXmlFragment('default'),
        );
        const before = Y.encodeStateVector(doc);
        // Append cloned blocks only: never reserialize or replace the user's existing rich content.
        const blocks = incoming.toArray().map((node) => {
          if (!(node instanceof Y.XmlElement) && !(node instanceof Y.XmlText))
            throw new Error('Unsupported note block.');
          return node.clone();
        });
        doc.transact(() => {
          fragment.insert(fragment.length, blocks);
        });
        await publish(itemId, doc, before, signal);
        return {
          id: itemId,
          appended: true,
          markdownChanges: parsed.scan,
          ...rawNote(parsed.scan),
        };
      } finally {
        doc.destroy();
        added.destroy();
      }
    },
    async planEdit(itemId, edit, signal) {
      const doc = await load(itemId, signal);
      try {
        return place(doc.getXmlFragment('default'), edit).plan;
      } finally {
        doc.destroy();
      }
    },
    async applyEdit(itemId, edit, approved, signal) {
      const doc = await load(itemId, signal);
      try {
        const placement = place(doc.getXmlFragment('default'), edit);
        if (placement.plan.fingerprint !== approved)
          throw refuse(
            'The note changed since you approved this. Read it again before editing.',
            'The note changed after you approved this, so nothing was edited.',
          );
        const elements = toElements(placement.blocks);
        const before = Y.encodeStateVector(doc);
        doc.transact(() => {
          placement.parent.delete(placement.index, placement.removeCount);
          if (elements.length) placement.parent.insert(placement.index, elements);
        });
        await publish(itemId, doc, before, signal);
        return {
          id: itemId,
          replaced: true,
          blocksRemoved: placement.plan.blocksRemoved,
          blocksAdded: placement.plan.blocksAdded,
          markdownChanges: placement.plan.markdownChanges,
          ...rawNote(placement.plan.markdownChanges),
        };
      } finally {
        doc.destroy();
      }
    },
  };
}
