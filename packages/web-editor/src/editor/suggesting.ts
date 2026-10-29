import { SUGGESTIBLE_BLOCKS, readBlockSuggestion, type BlockSuggestion } from '@nix/editor-schema';
import { Extension, type CommandProps, type Editor } from '@tiptap/core';
import {
  Mark,
  Slice,
  type MarkType,
  type Node as ProseMirrorNode,
  type Schema,
} from '@tiptap/pm/model';
import { Plugin, PluginKey, Selection, type EditorState, type Transaction } from '@tiptap/pm/state';
import {
  AddMarkStep,
  Mapping,
  RemoveMarkStep,
  ReplaceAroundStep,
  ReplaceStep,
} from '@tiptap/pm/transform';
import type { EditorView } from '@tiptap/pm/view';
import { ySyncPluginKey } from 'y-prosemirror';

/**
 * Suggesting mode (track changes) over the version 7 suggestion marks and block attribute.
 *
 * While the flag is on, a local edit is applied and then amended in the same dispatch by
 * `appendTransaction`, so the document never holds the unmarked version: typed text is marked as
 * an insert, deleted text is put back marked as a delete, a formatting change keeps the marks it
 * replaced, and a block created or removed carries `suggestion: { op }`. Because the amendment
 * rides in the edit's own dispatch, y-prosemirror writes both to Yjs as one change and one undo
 * reverts them together.
 *
 * **What it never touches.** Remote edits and undo (they carry the y-sync meta; the Markdown
 * mode's whole-body swap arrives the same way), its own commands, and composition: an IME owns
 * the DOM mid-word, so the composed range is marked after `compositionend` instead.
 *
 * shortcut: attribute changes (text alignment, task checkboxes, column widths) and text typed
 * over an IME selection are not tracked; a restructure rejects by restoring its snapshot, which
 * discards later edits inside the restructured blocks. Upgrade if reviewers hit either.
 */

export interface SuggestingStorage {
  enabled: boolean;
  /** The signed-in principal's subject; every suggestion is stamped with it. */
  authorId: string;
}

declare module '@tiptap/core' {
  interface Storage {
    suggesting: SuggestingStorage;
  }
  interface Commands<ReturnType> {
    suggesting: {
      acceptSuggestion: (id: string) => ReturnType;
      rejectSuggestion: (id: string) => ReturnType;
      acceptAllSuggestions: () => ReturnType;
      rejectAllSuggestions: () => ReturnType;
    };
  }
}

/** Turns suggesting mode on or off for an editor, and says who its suggestions belong to. */
export function setSuggesting(
  editor: Editor,
  state: { readonly enabled: boolean; readonly authorId: string },
): void {
  editor.storage.suggesting.enabled = state.enabled;
  editor.storage.suggesting.authorId = state.authorId;
}

export function isSuggesting(editor: Editor): boolean {
  return editor.storage.suggesting.enabled;
}

const OWN = new PluginKey('suggesting');
const SUGGESTION_MARKS = new Set(['suggestionInsert', 'suggestionDelete', 'suggestionFormat']);
const BLOCKS = new Set(SUGGESTIBLE_BLOCKS);
/** Comment threads are annotations, never a proposed change to the text. */
const UNTRACKED_MARKS = new Set([...SUGGESTION_MARKS, 'comment']);
const COMPOSITION_SETTLE_MS = 60;

interface Stamp {
  readonly id: string;
  readonly authorId: string;
  readonly createdAt: string;
}

function stamp(authorId: string): Stamp {
  return { id: crypto.randomUUID(), authorId, createdAt: new Date().toISOString() };
}

const blockSuggestion = (node: ProseMirrorNode): BlockSuggestion | null =>
  readBlockSuggestion(node.attrs.suggestion);

const isSuggestible = (node: ProseMirrorNode): boolean =>
  node.isBlock && BLOCKS.has(node.type.name);

function markType(schema: Schema, name: string): MarkType {
  const type = schema.marks[name];
  if (type === undefined) throw new Error(`The schema has no ${name} mark.`);
  return type;
}

/** A suggestion's id as stored on a mark; the empty string for anything unreadable. */
function idOf(mark: Mark): string {
  const id: unknown = mark.attrs.id;
  return typeof id === 'string' ? id : '';
}

function ownMark(node: ProseMirrorNode | null | undefined, name: string, authorId: string) {
  return node?.marks.find((mark) => mark.type.name === name && mark.attrs.authorId === authorId);
}

/** Marks `from..to` as inserted by `who`, and the blocks that start inside it as inserted blocks. */
function markInserted(tr: Transaction, from: number, to: number, authorId: string): void {
  if (from >= to) return;
  const { marks } = tr.doc.type.schema;
  // Typing next to one's own insert extends it rather than starting a second suggestion.
  const neighbour =
    ownMark(tr.doc.resolve(from).nodeBefore, 'suggestionInsert', authorId) ??
    ownMark(tr.doc.resolve(to).nodeAfter, 'suggestionInsert', authorId);
  const attrs: Stamp =
    neighbour === undefined
      ? stamp(authorId)
      : { id: idOf(neighbour), authorId, createdAt: String(neighbour.attrs.createdAt) };
  // Text carried in from elsewhere (a paste, text typed inside a struck run) brings its own marks.
  for (const name of SUGGESTION_MARKS) tr.removeMark(from, to, marks[name]);
  tr.addMark(from, to, markType(tr.doc.type.schema, 'suggestionInsert').create(attrs));
  const blocks: number[] = [];
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (pos >= from && isSuggestible(node)) blocks.push(pos);
  });
  for (const pos of blocks) tr.setNodeAttribute(pos, 'suggestion', { ...attrs, op: 'insert' });
}

/**
 * Puts `deleted` back at `at`, marked as a deletion. Text and blocks the same author inserted
 * are removed for real. Returns where the restored content starts, or null if none stayed.
 */
function restoreDeleted(
  tr: Transaction,
  deleted: Slice,
  at: number,
  authorId: string,
): number | null {
  const first = tr.steps.length;
  tr.replace(at, at, deleted);
  if (tr.steps.length === first) return null;
  const end = tr.mapping.slice(first).map(at, 1);

  const own: [number, number][] = [];
  tr.doc.nodesBetween(at, end, (node, pos) => {
    const suggestion = blockSuggestion(node);
    if (
      suggestion?.op === 'insert' &&
      suggestion.authorId === authorId &&
      pos >= at &&
      pos + node.nodeSize <= end
    ) {
      own.push([pos, pos + node.nodeSize]);
      return false;
    }
    if (node.isText && ownMark(node, 'suggestionInsert', authorId) !== undefined) {
      own.push([Math.max(pos, at), Math.min(pos + node.nodeSize, end)]);
    }
    return true;
  });
  const removing = tr.steps.length;
  for (const [from, to] of own.reverse()) tr.delete(from, to);
  const to = tr.mapping.slice(removing).map(end, -1);

  const attrs = stamp(authorId);
  const texts: [number, number][] = [];
  const blocks: number[] = [];
  tr.doc.nodesBetween(at, to, (node, pos) => {
    if (node.isText) {
      if (!node.marks.some((mark) => mark.type.name === 'suggestionDelete')) {
        texts.push([Math.max(pos, at), Math.min(pos + node.nodeSize, to)]);
      }
    } else if (
      isSuggestible(node) &&
      pos >= at &&
      pos + node.nodeSize <= to &&
      blockSuggestion(node) === null
    ) {
      blocks.push(pos);
    }
  });
  for (const [from, upTo] of texts)
    tr.addMark(from, upTo, markType(tr.doc.type.schema, 'suggestionDelete').create(attrs));
  for (const pos of blocks) tr.setNodeAttribute(pos, 'suggestion', { ...attrs, op: 'delete' });
  return texts.length + blocks.length === 0 ? null : at;
}

/** A backspace or delete that only removes the boundary between blocks: no content to strike. */
function isBoundaryJoin(doc: ProseMirrorNode, step: ReplaceStep): boolean {
  if (step.slice.size !== 0 || step.from >= step.to) return false;
  const deleted = doc.slice(step.from, step.to);
  if (deleted.openStart === 0 && deleted.openEnd === 0) return false;
  let content = false;
  deleted.content.descendants((node) => {
    content = content || node.isLeaf;
    return !content;
  });
  return !content;
}

function suggestingPlugin(storage: SuggestingStorage, isEditable: () => boolean): Plugin {
  let lastKey: string | null = null;
  /** The range a composition has written so far, marked once it ends. */
  let composed: { from: number; to: number } | null = null;

  const skipped = (tr: Transaction): boolean =>
    tr.getMeta(OWN) !== undefined ||
    tr.getMeta(ySyncPluginKey) !== undefined ||
    tr.getMeta('composition') !== undefined;
  const active = (): boolean => storage.enabled && storage.authorId !== '' && isEditable();

  const flushComposition = (view: EditorView): void => {
    const range = composed;
    composed = null;
    if (range === null || view.isDestroyed || !active()) return;
    const tr = view.state.tr;
    markInserted(tr, range.from, Math.min(range.to, tr.doc.content.size), storage.authorId);
    view.dispatch(tr.setMeta(OWN, true));
  };

  return new Plugin({
    key: OWN,
    props: {
      handleKeyDown: (_view, event) => {
        lastKey = event.key;
        return false;
      },
      handleDOMEvents: {
        compositionend: (view) => {
          setTimeout(() => {
            flushComposition(view);
          }, COMPOSITION_SETTLE_MS);
          return false;
        },
      },
    },

    // A backspace at the start of a block would silently join it to the one before; there is
    // nothing to strike, so it does nothing unless the block is the author's own pending split.
    filterTransaction: (tr) => {
      if (!tr.docChanged || skipped(tr) || !active()) return true;
      return tr.steps.every((step, index) => {
        const doc = tr.docs[index];
        if (doc === undefined || !(step instanceof ReplaceStep) || !isBoundaryJoin(doc, step)) {
          return true;
        }
        const joined = blockSuggestion(doc.resolve(step.to).parent);
        return joined?.op === 'insert' && joined.authorId === storage.authorId;
      });
    },

    appendTransaction: (transactions, _oldState, newState) => {
      // Without the marks in the schema `removeMark(…, undefined)` would strip every mark.
      if (!active() || newState.schema.marks.suggestionInsert === undefined) return null;
      const fix = newState.tr;
      const authorId = storage.authorId;
      const restored: { at: number | null } = { at: null };

      transactions.forEach((tr, index) => {
        if (!tr.docChanged) return;
        if (composed !== null) {
          composed = {
            from: tr.mapping.map(composed.from, -1),
            to: tr.mapping.map(composed.to, 1),
          };
        }
        if (tr.getMeta('composition') !== undefined) {
          tr.steps.forEach((step, i) => {
            const rest = tr.mapping.slice(i + 1);
            step.getMap().forEach((_from, _to, start, end) => {
              composed = {
                from: Math.min(composed?.from ?? Infinity, rest.map(start, -1)),
                to: Math.max(composed?.to ?? 0, rest.map(end, 1)),
              };
            });
          });
        }
        if (skipped(tr)) return;

        const later = new Mapping();
        for (const next of transactions.slice(index + 1)) {
          for (const map of next.mapping.maps) later.appendMap(map);
        }
        tr.steps.forEach((step, i) => {
          const after = new Mapping();
          for (const map of tr.mapping.maps.slice(i + 1)) after.appendMap(map);
          for (const map of later.maps) after.appendMap(map);
          const at = (pos: number, assoc: 1 | -1 = 1): number =>
            fix.mapping.map(after.map(pos, assoc), assoc);
          const before = tr.docs[i];
          if (before === undefined) return;

          if (step instanceof ReplaceStep) {
            markInserted(fix, at(step.from, -1), at(step.from + step.slice.size, 1), authorId);
            if (step.to > step.from && !isBoundaryJoin(before, step)) {
              const start = restoreDeleted(
                fix,
                before.slice(step.from, step.to),
                at(step.from, -1),
                authorId,
              );
              if (start !== null && lastKey === 'Backspace') restored.at = start;
            }
          } else if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
            if (UNTRACKED_MARKS.has(step.mark.type.name)) return;
            const attrs = stamp(authorId);
            before.nodesBetween(step.from, step.to, (node, pos) => {
              if (
                !node.isText ||
                ownMark(node, 'suggestionInsert', authorId) !== undefined ||
                node.marks.some((mark) => mark.type.name === 'suggestionFormat')
              ) {
                return true;
              }
              const original = node.marks.filter((mark) => !SUGGESTION_MARKS.has(mark.type.name));
              fix.addMark(
                at(Math.max(pos, step.from)),
                at(Math.min(pos + node.nodeSize, step.to), -1),
                markType(newState.schema, 'suggestionFormat').create({
                  ...attrs,
                  before: JSON.stringify(original.map((mark): unknown => mark.toJSON())),
                }),
              );
              return true;
            });
          } else if (step instanceof ReplaceAroundStep) {
            const map = step.getMap();
            const from = at(map.map(step.from, -1), -1);
            const to = at(map.map(step.to, 1), 1);
            const top: { pos: number; node: ProseMirrorNode }[] = [];
            fix.doc.nodesBetween(from, to, (node, pos) => {
              if (pos < from || pos + node.nodeSize > to || !isSuggestible(node)) return true;
              top.push({ pos, node });
              return false;
            });
            const first = top[0];
            const last = top[top.length - 1];
            // Only a restructure that is exactly its blocks can be rejected exactly.
            if (
              first === undefined ||
              last === undefined ||
              first.pos !== from ||
              last.pos + last.node.nodeSize !== to ||
              top.some(({ node }) => blockSuggestion(node) !== null)
            ) {
              return;
            }
            const attrs = { ...stamp(authorId), op: 'restructure' };
            const snapshot = JSON.stringify(before.slice(step.from, step.to).toJSON());
            top.forEach(({ pos }, n) => {
              fix.setNodeAttribute(
                pos,
                'suggestion',
                n === 0 ? { ...attrs, before: snapshot } : attrs,
              );
            });
          }
        });
      });

      if (restored.at !== null) {
        fix.setSelection(Selection.near(fix.doc.resolve(restored.at), 1));
      }
      if (transactions.some((tr) => tr.docChanged)) lastKey = null;
      return fix.docChanged || fix.selectionSet ? fix.setMeta(OWN, true) : null;
    },
  });
}

interface FoundText {
  readonly from: number;
  readonly to: number;
  readonly node: ProseMirrorNode;
  readonly mark: Mark;
}

interface FoundBlock {
  readonly pos: number;
  readonly node: ProseMirrorNode;
  readonly suggestion: BlockSuggestion;
}

function gather(doc: ProseMirrorNode, ids: ReadonlySet<string> | null) {
  const texts: FoundText[] = [];
  const blocks: FoundBlock[] = [];
  doc.descendants((node, pos) => {
    if (node.isText) {
      for (const mark of node.marks) {
        if (SUGGESTION_MARKS.has(mark.type.name) && (ids === null || ids.has(idOf(mark)))) {
          texts.push({ from: pos, to: pos + node.nodeSize, node, mark });
        }
      }
      return false;
    }
    const suggestion = isSuggestible(node) ? blockSuggestion(node) : null;
    if (suggestion !== null && (ids === null || ids.has(suggestion.id))) {
      blocks.push({ pos, node, suggestion });
    }
    return true;
  });
  return { texts, blocks };
}

interface Edit {
  readonly from: number;
  readonly to: number;
  readonly slice?: Slice;
}

/** Whether `node` still has text once the given author-agnostic inserted text is gone. */
function keepsText(node: ProseMirrorNode): boolean {
  let kept = false;
  node.descendants((child) => {
    kept =
      kept || (child.isText && !child.marks.some((mark) => mark.type.name === 'suggestionInsert'));
    return !kept;
  });
  return kept;
}

/** Where the first textblock at or inside `node` that keeps text starts. */
function firstTextblock(node: ProseMirrorNode, pos: number): number | null {
  if (node.isTextblock) return keepsText(node) ? pos : null;
  const found: number[] = [];
  node.descendants((child, offset) => {
    if (found.length === 0 && child.isTextblock && keepsText(child)) found.push(pos + 1 + offset);
    return found.length === 0;
  });
  return found[0] ?? null;
}

/** The end of the content of the last textblock that finishes before `pos`. */
function textblockEndBefore(doc: ProseMirrorNode, pos: number): number | null {
  const ends: number[] = [];
  doc.descendants((child, offset) => {
    if (child.isTextblock && offset + child.nodeSize <= pos) ends.push(offset + child.nodeSize - 1);
    return offset < pos;
  });
  return ends[ends.length - 1] ?? null;
}

/**
 * Accepts or rejects suggestions (`ids`, or all of them) on `tr`. Mark and attribute changes go
 * first because they move nothing; the edits that remove or restore content are applied from the
 * end of the document backwards so each position is still where it was read.
 */
function resolve(
  tr: Transaction,
  mode: 'accept' | 'reject',
  ids: ReadonlySet<string> | null,
): boolean {
  const accept = mode === 'accept';
  const { texts, blocks } = gather(tr.doc, ids);
  if (texts.length + blocks.length === 0) return false;
  const schema = tr.doc.type.schema;
  const edits: Edit[] = [];
  const deletes = new Map<string, Edit[]>();

  for (const { from, to, node, mark } of texts) {
    const kind = mark.type.name;
    if (kind === 'suggestionFormat') {
      if (!accept) {
        for (const current of node.marks) {
          if (!SUGGESTION_MARKS.has(current.type.name)) tr.removeMark(from, to, current);
        }
        try {
          const original: unknown = JSON.parse(String(mark.attrs.before));
          for (const json of Array.isArray(original) ? original : []) {
            tr.addMark(from, to, Mark.fromJSON(schema, json));
          }
        } catch {
          // An unreadable snapshot leaves the current formatting in place.
        }
      }
      tr.removeMark(from, to, mark);
    } else if ((kind === 'suggestionInsert') === accept) {
      tr.removeMark(from, to, mark);
    } else if (accept) {
      const id = idOf(mark);
      deletes.set(id, [...(deletes.get(id) ?? []), { from, to }]);
    } else {
      edits.push({ from, to });
    }
  }

  let coveredUntil = 0;
  for (const { pos, node, suggestion } of blocks) {
    const { op } = suggestion;
    const end = pos + node.nodeSize;
    if (op === 'delete' && accept) {
      deletes.set(suggestion.id, [...(deletes.get(suggestion.id) ?? []), { from: pos, to: end }]);
    } else if (op === 'insert' && !accept && pos >= coveredUntil) {
      coveredUntil = end;
      if (!keepsText(node)) {
        edits.push({ from: pos, to: end });
      } else {
        // A split block that still holds the author's text before the split: join it back.
        const tail = firstTextblock(node, pos);
        const previous = tail === null ? null : textblockEndBefore(tr.doc, pos);
        if (tail !== null && previous !== null) edits.push({ from: previous, to: tail + 1 });
        tr.setNodeAttribute(pos, 'suggestion', null);
      }
    } else if (op === 'restructure' && !accept && typeof suggestion.before === 'string') {
      const run = blocks.filter(
        (other) => other.suggestion.id === suggestion.id && other.suggestion.op === 'restructure',
      );
      const last = run[run.length - 1];
      if (run[0]?.pos === pos && last !== undefined) {
        edits.push({
          from: pos,
          to: last.pos + last.node.nodeSize,
          slice: Slice.fromJSON(schema, JSON.parse(suggestion.before)),
        });
      }
    } else if (op !== 'insert' || accept) {
      tr.setNodeAttribute(pos, 'suggestion', null);
    }
  }
  for (const ranges of deletes.values()) {
    edits.push({
      from: Math.min(...ranges.map((range) => range.from)),
      to: Math.max(...ranges.map((range) => range.to)),
    });
  }

  // Drop an edit that lies inside a larger one, then apply from the end backwards.
  edits.sort((a, b) => a.from - b.from || b.to - a.to);
  const applied: Edit[] = [];
  for (const edit of edits) {
    const outer = applied[applied.length - 1];
    if (outer === undefined || edit.from >= outer.to) applied.push(edit);
  }
  for (const edit of applied.reverse()) {
    if (edit.slice === undefined) tr.delete(edit.from, edit.to);
    else tr.replace(edit.from, edit.to, edit.slice);
  }
  return true;
}

export const Suggesting = Extension.create<Record<string, never>, SuggestingStorage>({
  name: 'suggesting',

  addStorage() {
    return { enabled: false, authorId: '' };
  },

  addCommands() {
    const run =
      (mode: 'accept' | 'reject', ids: ReadonlySet<string> | null) =>
      ({ tr, dispatch }: CommandProps): boolean => {
        if (dispatch === undefined) {
          const found = gather(tr.doc, ids);
          return found.texts.length + found.blocks.length > 0;
        }
        tr.setMeta(OWN, true);
        return resolve(tr, mode, ids);
      };
    return {
      acceptSuggestion: (id) => run('accept', new Set([id])),
      rejectSuggestion: (id) => run('reject', new Set([id])),
      acceptAllSuggestions: () => run('accept', null),
      rejectAllSuggestions: () => run('reject', null),
    };
  },

  addProseMirrorPlugins() {
    return [suggestingPlugin(this.storage, () => this.editor.isEditable)];
  },
});

/**
 * The suggestions under the selection: any that overlaps a range, or, for a caret, one whose
 * text runs on both sides of it (a caret at the end of what is being typed is not "inside").
 */
export function suggestionIdsAt(state: EditorState): string[] {
  const { from, to, empty, $from } = state.selection;
  const ids = new Set<string>();
  const markIds = (node: ProseMirrorNode | null | undefined): string[] =>
    (node?.marks ?? [])
      .filter((mark) => SUGGESTION_MARKS.has(mark.type.name) && typeof mark.attrs.id === 'string')
      .map((mark) => mark.attrs.id as string);
  if (empty) {
    const after = new Set(markIds($from.nodeAfter));
    for (const id of markIds($from.nodeBefore)) if (after.has(id)) ids.add(id);
    return [...ids];
  }
  state.doc.nodesBetween(from, to, (node) => {
    for (const id of markIds(node)) ids.add(id);
    const suggestion = isSuggestible(node) ? blockSuggestion(node) : null;
    if (suggestion !== null) ids.add(suggestion.id);
  });
  return [...ids];
}

/** Whether the document holds any suggestion; stops at the first. */
export function hasSuggestions(doc: ProseMirrorNode): boolean {
  let found = false;
  doc.descendants((node) => {
    found =
      found ||
      (node.isText
        ? node.marks.some((mark) => SUGGESTION_MARKS.has(mark.type.name))
        : blockSuggestion(node) !== null);
    return !found;
  });
  return found;
}

export interface SuggestionEntry {
  readonly id: string;
  readonly authorId: string;
  readonly createdAt: string;
  readonly kind: 'insert' | 'delete' | 'format' | 'block';
  readonly excerpt: string;
  readonly from: number;
  readonly to: number;
}

const EXCERPT_LENGTH = 120;
const MARK_KINDS: Readonly<Record<string, SuggestionEntry['kind'] | undefined>> = {
  suggestionInsert: 'insert',
  suggestionDelete: 'delete',
  suggestionFormat: 'format',
};

/**
 * One entry per suggestion id, in document order. A suggestion that touches both text and
 * blocks is reported by its text kind; `block` means it only has block-level marks.
 */
export function listSuggestions(doc: ProseMirrorNode): SuggestionEntry[] {
  const entries = new Map<string, { entry: SuggestionEntry; text: string }>();
  const note = (
    attrs: { id?: unknown; authorId?: unknown; createdAt?: unknown },
    kind: SuggestionEntry['kind'],
    from: number,
    to: number,
    text: string,
  ): void => {
    if (typeof attrs.id !== 'string') return;
    const known = entries.get(attrs.id);
    if (known === undefined) {
      entries.set(attrs.id, {
        text,
        entry: {
          id: attrs.id,
          authorId: typeof attrs.authorId === 'string' ? attrs.authorId : '',
          createdAt: typeof attrs.createdAt === 'string' ? attrs.createdAt : '',
          kind,
          excerpt: '',
          from,
          to,
        },
      });
      return;
    }
    known.text += text;
    known.entry = {
      ...known.entry,
      kind: known.entry.kind === 'block' ? kind : known.entry.kind,
      from: Math.min(known.entry.from, from),
      to: Math.max(known.entry.to, to),
    };
  };

  doc.descendants((node, pos) => {
    if (node.isText) {
      for (const mark of node.marks) {
        const kind = MARK_KINDS[mark.type.name];
        if (kind !== undefined) note(mark.attrs, kind, pos, pos + node.nodeSize, node.text ?? '');
      }
      return false;
    }
    const suggestion = blockSuggestion(node);
    if (suggestion !== null) note(suggestion, 'block', pos, pos + node.nodeSize, node.textContent);
    return true;
  });

  return [...entries.values()]
    .map(({ entry, text }) => ({
      ...entry,
      excerpt: text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH)}...` : text,
    }))
    .sort((a, b) => a.from - b.from);
}
