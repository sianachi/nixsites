import {
  isNixApiError,
  MAXIMUM_MENTION_EXCLUSIONS,
  MAXIMUM_MENTION_TEXT_LENGTH,
  type Mentions,
} from '@nix/api-client';
import { Extension, type Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { ySyncPluginKey } from 'y-prosemirror';

import { announce } from '../a11y/announcer';
import { recordPick } from '../lib/frecency';
import { candidatesIn, locateMentions, type MentionCandidate } from '../lib/suggest/ref-mentions';
import { readDismissals, rememberDismissal } from '../lib/suggestion-dismissals';
import { choiceOrderOn } from '../lib/suggestion-preferences';
import { linkedTargets, linkFrecencyNamespace } from './reference-menu';
import { vimStatusMode } from './vim-motions';

/**
 * Item titles written in a note but not linked, underlined - and one keystroke from becoming a link.
 *
 * **Decorations, never content.** The underline is an inline decoration: drawn over text the
 * person wrote, absent from the document, the Yjs fragment, the body cache and every export.
 * Nothing changes until somebody chooses "Link to ..." (the bubble, or Alt+Enter with the caret
 * in the phrase), and then the phrase becomes a `reference` node in one transaction - the same
 * node the picker inserts - and the pick is remembered as the picker's would be.
 *
 * **What is asked, and when.** The server's `findMentions` reads text and names the readable
 * items in this workspace whose titles appear in it. It has its own per-address rate limit, so it
 * is asked:
 *
 * - once the note has content, for its first `MAX_REQUEST_CHARS` of prose (the part on screen when
 *   a note opens), and after that
 * - for the blocks this person changed, after `IDLE_MS` without a local edit, never more often
 *   than `MIN_INTERVAL_MS`, one request at a time, all changed blocks batched into one request.
 *
 * Each block's answer is cached by its exact text, so a block typed back to something already
 * asked about costs nothing. Nothing is asked while the editor is read-only, offline, composing
 * with an IME, or with the preference off. A colleague's edits do not trigger a request: their
 * client asks for their own changes. Later blocks of a long note are underlined as they are
 * edited, not on open - a deliberate bound on how much of the rate limit opening a note can spend.
 * Blocks past one request's text limit stay queued for the next request rather than being dropped.
 *
 * **A partial answer is not cached.** When the server says its answer was `truncated`, it may not
 * have looked at every block that was sent, so none of them is cached; each is asked about again
 * on its own, one block per request. A block that is truncated alone is drawn from what came back
 * and left uncached, so its next edit asks again.
 *
 * **A refusal is waited out.** A 429 pauses every lookup for the `Retry-After` the server sent
 * (`RATE_LIMIT_PAUSE_MS` when it sent none), and the refused blocks are queued again.
 *
 * **Stale answers are dropped.** A request records where its blocks were and what they said; those
 * positions are mapped through every transaction while it is in flight, and when the answer lands
 * a block whose text has changed since is not decorated from it. An underline already drawn is
 * mapped with the document and removed the moment its text stops being the text it matched.
 *
 * **What is never underlined.** Code blocks and inline code, the labels of existing references,
 * the note itself, items this note already links to, items this person said not to suggest in this
 * workspace (`dismissMention`), and items in other workspaces - a link to those stays one `[[`
 * away, and offering them unasked would underline every common word some other workspace happens
 * to use as a title. The server does that filtering: each request names the workspace and sends
 * the note, its link targets and the dismissed items as `excludeIds` (at most
 * `MAX_EXCLUDED_IDS`), so no result slot is spent on them. What the client still filters is only
 * what the server cannot know: links made in this note after the request left, and an answer
 * served from the cache, which was fetched before the newest link or dismissal.
 *
 * **Keyboard and screen readers.** Decorations cannot take focus, so the affordance is the caret:
 * with it inside an underlined phrase, Alt+Enter links it, and `MentionBubble` shows a "Link to"
 * button after the editor in the tab order and announces once that the phrase names an item.
 */

/** How long typing has to pause before changed blocks are asked about. */
export const IDLE_MS = 1_200;

/** The least time between two requests, whatever else is happening. */
export const MIN_INTERVAL_MS = 2_000;

/** The server's limit on one request's text. */
export const MAX_REQUEST_CHARS = MAXIMUM_MENTION_TEXT_LENGTH;

/** The server's limit on one request's exclusions. */
export const MAX_EXCLUDED_IDS = MAXIMUM_MENTION_EXCLUSIONS;

/** How long lookups pause after a 429 that carried no `Retry-After`. */
export const RATE_LIMIT_PAUSE_MS = 60_000;

/** The most underlines drawn in the whole note. */
export const MAX_DECORATIONS = 200;

/** Block answers remembered, by exact block text. */
const CACHE_ENTRIES = 300;

/** The most changed positions remembered between requests. */
const MAX_DIRTY = 32;

/**
 * Dotted and muted, so it reads as a quiet offer rather than a link or a spelling error - a solid
 * accent underline would be indistinguishable from the links themselves.
 */
export const MENTION_CLASS = 'underline decoration-dotted decoration-muted underline-offset-4';

/** One lookup: the passage, and the items the server must not return. */
export interface MentionLookup {
  readonly text: string;
  readonly excludeIds: readonly string[];
}

/** What the editor tells this extension. Replaced by `setMentionContext`, read on demand. */
export interface MentionContext {
  readonly enabled: boolean;
  readonly workspaceId?: string | undefined;
  readonly currentItemId?: string | undefined;
  /**
   * The server lookup, already scoped to `workspaceId`; absent in contexts with no client or no
   * workspace.
   */
  readonly find?: ((lookup: MentionLookup, signal: AbortSignal) => Promise<Mentions>) | undefined;
}

/** The dismissal key for an item in a workspace: never suggest it there again. */
export function mentionDismissalKey(workspaceId: string, itemId: string): string {
  return `mention:${workspaceId}:${itemId}`;
}

/** The items dismissed in `workspaceId`, read from the dismissal store. */
function dismissedIn(workspaceId: string | undefined): string[] {
  if (workspaceId === undefined) return [];
  const prefix = mentionDismissalKey(workspaceId, '');
  const ids: string[] = [];
  for (const key of readDismissals()) {
    if (key.startsWith(prefix) && key.length > prefix.length) ids.push(key.slice(prefix.length));
  }
  return ids;
}

export interface MentionStorage {
  context: MentionContext;
}

declare module '@tiptap/core' {
  interface Storage {
    unlinkedMentions: MentionStorage;
  }
}

/** One underline's meaning: what it names and exactly the text it matched. */
interface MentionSpec {
  readonly itemId: string;
  readonly title: string;
  readonly text: string;
}

/** An underlined mention, in document positions. */
export interface ActiveMention {
  readonly from: number;
  readonly to: number;
  readonly itemId: string;
  readonly title: string;
}

/** A block sent to the server: where it starts (mapped while in flight) and what it said. */
interface SentBlock {
  readonly pos: number;
  readonly text: string;
}

interface MentionState {
  readonly decorations: DecorationSet;
  /** Positions inside blocks changed locally since the last request. */
  readonly dirty: readonly number[];
  /** The blocks of the request in flight. */
  readonly pending: readonly SentBlock[];
}

/** One block's decorations, in document positions, replacing whatever the block had. */
interface FoundBlock {
  readonly pos: number;
  readonly size: number;
  readonly ranges: readonly { from: number; to: number; spec: MentionSpec }[];
}

type MentionMeta =
  /** A request left with `blocks`; `remaining` are the changed positions it did not cover. */
  | {
      readonly kind: 'sent';
      readonly blocks: readonly SentBlock[];
      readonly remaining: readonly number[];
    }
  | { readonly kind: 'found'; readonly blocks: readonly FoundBlock[] }
  /** Positions to ask about again: a refused or partial answer. */
  | { readonly kind: 'requeue'; readonly positions: readonly number[] }
  /** Every underline of `itemId` goes: linked in this note, or dismissed. */
  | { readonly kind: 'withdrawn'; readonly itemId: string }
  | { readonly kind: 'clear' };

export const unlinkedMentionsKey = new PluginKey<MentionState>('nixUnlinkedMentions');

const NO_CONTEXT: MentionContext = { enabled: false };

function readMeta(transaction: Transaction): MentionMeta | null {
  const raw: unknown = transaction.getMeta(unlinkedMentionsKey);
  return typeof raw === 'object' && raw !== null && 'kind' in raw ? (raw as MentionMeta) : null;
}

function specOf(decoration: Decoration): MentionSpec {
  return decoration.spec as MentionSpec;
}

/**
 * A block's text with one character per document position: prose as written, and U+FFFC for
 * everything that is not prose here - a reference's label, inline code, a hard break - so offsets
 * in the string are offsets in the block and no phrase can be matched through one.
 */
export function mentionText(block: ProseMirrorNode): string {
  const parts: string[] = [];
  block.forEach((child) => {
    if (child.isText && !child.marks.some((mark) => mark.type.spec.code === true)) {
      parts.push(child.text ?? '');
    } else {
      parts.push('￼'.repeat(child.nodeSize));
    }
  });
  return parts.join('');
}

/** Every underline currently drawn. */
export function mentionsIn(state: EditorState): readonly ActiveMention[] {
  const set = unlinkedMentionsKey.getState(state)?.decorations ?? DecorationSet.empty;
  return set.find().map((decoration) => ({
    from: decoration.from,
    to: decoration.to,
    itemId: specOf(decoration).itemId,
    title: specOf(decoration).title,
  }));
}

/** The underlined mention the caret is in or touching, if any. */
export function activeMention(state: EditorState): ActiveMention | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const set = unlinkedMentionsKey.getState(state)?.decorations ?? DecorationSet.empty;
  const head = selection.head;
  const found = set
    .find(head, head)
    .find((decoration) => decoration.from <= head && head <= decoration.to);
  if (found === undefined) return null;
  return {
    from: found.from,
    to: found.to,
    itemId: specOf(found).itemId,
    title: specOf(found).title,
  };
}

/**
 * Replaces the mention with a reference to the item it names, in one transaction, and remembers
 * the pick. Refuses (returns false) if the text is no longer what was matched - a colleague may
 * have changed it since the underline was drawn.
 */
export function linkMention(editor: Editor, mention: ActiveMention): boolean {
  const { state } = editor;
  const decorations = unlinkedMentionsKey.getState(state)?.decorations ?? DecorationSet.empty;
  const current = decorations
    .find(mention.from, mention.to)
    .find((decoration) => decoration.from === mention.from && decoration.to === mention.to);
  if (
    current === undefined ||
    !editor.isEditable ||
    state.doc.textBetween(mention.from, mention.to) !== specOf(current).text
  ) {
    return false;
  }
  const linked = editor
    .chain()
    .focus()
    .insertContentAt(
      { from: mention.from, to: mention.to },
      {
        type: 'reference',
        attrs: { kind: 'item', targetId: mention.itemId, label: mention.title },
      },
    )
    .run();
  if (!linked) return false;

  // Every other underline of the same item goes too: it is linked in this note now.
  withdraw(editor, mention.itemId);
  const workspaceId = editor.storage.unlinkedMentions.context.workspaceId;
  if (workspaceId !== undefined && choiceOrderOn()) {
    recordPick(linkFrecencyNamespace(workspaceId), mention.itemId);
  }
  announce(`Linked to ${mention.title}.`);
  return true;
}

function withdraw(editor: Editor, itemId: string): void {
  editor.view.dispatch(
    editor.state.tr
      .setMeta(unlinkedMentionsKey, { kind: 'withdrawn', itemId } satisfies MentionMeta)
      .setMeta('addToHistory', false),
  );
}

/**
 * "Don't suggest this": remembers, for this workspace in this browser, never to underline the item
 * again, and removes its underlines now. Later lookups send it in `excludeIds`.
 */
export function dismissMention(editor: Editor, mention: ActiveMention): void {
  const workspaceId = editor.storage.unlinkedMentions.context.workspaceId;
  if (workspaceId !== undefined) {
    rememberDismissal(mentionDismissalKey(workspaceId, mention.itemId));
  }
  withdraw(editor, mention.itemId);
  announce(
    `${mention.title} will not be suggested in this workspace again. You can bring it back in Settings.`,
  );
}

/** Tells an editor's mention underlines what they need. Call from an effect. */
export function setMentionContext(editor: Editor, context: MentionContext): void {
  editor.storage.unlinkedMentions.context = context;
  if (!context.enabled && !editor.isDestroyed && mentionsIn(editor.state).length > 0) {
    editor.view.dispatch(
      editor.state.tr
        .setMeta(unlinkedMentionsKey, { kind: 'clear' } satisfies MentionMeta)
        .setMeta('addToHistory', false),
    );
  }
}

/** Where each local step changed the document, in the final document's coordinates. */
function changedPositions(transaction: Transaction): number[] {
  const positions: number[] = [];
  const { mapping } = transaction;
  mapping.maps.forEach((map, index) => {
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      const rest = mapping.slice(index + 1);
      positions.push(rest.map(newStart, -1), rest.map(newEnd, 1));
    });
  });
  return positions;
}

function nextState(transaction: Transaction, value: MentionState): MentionState {
  const meta = readMeta(transaction);
  const doc = transaction.doc;
  let decorations = value.decorations.map(transaction.mapping, doc);

  if (transaction.docChanged) {
    // An underline whose text is no longer what it matched has lost its meaning.
    const broken = decorations
      .find()
      .filter(
        (decoration) => doc.textBetween(decoration.from, decoration.to) !== specOf(decoration).text,
      );
    if (broken.length > 0) decorations = decorations.remove(broken);
  }

  const remote = transaction.getMeta(ySyncPluginKey) !== undefined;
  let dirty = value.dirty.map((pos) => transaction.mapping.map(pos));
  if (transaction.docChanged && !remote) {
    dirty = [...dirty, ...changedPositions(transaction)].slice(-MAX_DIRTY);
  }
  let pending: readonly SentBlock[] = value.pending.flatMap((block) => {
    const result = transaction.mapping.mapResult(block.pos, 1);
    return result.deleted ? [] : [{ ...block, pos: result.pos }];
  });

  switch (meta?.kind) {
    case 'sent':
      dirty = [...meta.remaining];
      pending = meta.blocks;
      break;
    case 'requeue':
      dirty = [...dirty, ...meta.positions].slice(-MAX_DIRTY);
      break;
    case 'found': {
      for (const block of meta.blocks) {
        decorations = decorations.remove(decorations.find(block.pos, block.pos + block.size));
        const room = MAX_DECORATIONS - decorations.find().length;
        const added = block.ranges
          .slice(0, Math.max(0, room))
          .map((range) =>
            Decoration.inline(
              range.from,
              range.to,
              { class: MENTION_CLASS, 'data-unlinked-mention': range.spec.itemId },
              { ...range.spec, inclusiveStart: false, inclusiveEnd: false },
            ),
          );
        decorations = decorations.add(doc, added);
      }
      pending = [];
      break;
    }
    case 'withdrawn':
      decorations = decorations.remove(
        decorations.find().filter((decoration) => specOf(decoration).itemId === meta.itemId),
      );
      break;
    case 'clear':
      decorations = DecorationSet.empty;
      dirty = [];
      pending = [];
      break;
    case undefined:
      break;
  }

  return { decorations, dirty, pending };
}

/** A text block of the document: where it starts and the node. */
interface Block {
  readonly pos: number;
  readonly node: ProseMirrorNode;
}

function blockAt(doc: ProseMirrorNode, pos: number): Block | null {
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  const $pos = doc.resolve(clamped);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node.isTextblock) return { pos: $pos.before(depth), node };
  }
  // Between blocks: the block starting here, if there is one.
  const after = $pos.nodeAfter;
  return after?.isTextblock === true ? { pos: clamped, node: after } : null;
}

/** Prose text blocks from the top of the document, until `budget` characters. */
function leadingBlocks(doc: ProseMirrorNode, budget: number): Block[] {
  const blocks: Block[] = [];
  let used = 0;
  doc.descendants((node, pos) => {
    if (used >= budget) return false;
    if (!node.isTextblock) return true;
    if (node.type.spec.code !== true && node.textContent.trim().length > 0) {
      blocks.push({ pos, node });
      used += node.content.size + 1;
    }
    return false;
  });
  return blocks;
}

/**
 * Whether the view has been torn down. A function so the check after an `await` is read fresh -
 * written inline, the compiler carries the earlier answer across the suspension.
 */
function destroyed(view: EditorView): boolean {
  return view.isDestroyed;
}

function mentionsPlugin(storage: () => MentionStorage): Plugin<MentionState> {
  /** Block text to the candidates found in it, oldest first for eviction. */
  const cache = new Map<string, readonly MentionCandidate[]>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: AbortController | null = null;
  let lastSentAt = -Infinity;
  let initialDone = false;
  /** No request before this time: a 429's `Retry-After`. */
  let pausedUntil = -Infinity;
  /** How many of the next requests carry one block each, after a truncated answer. */
  let soloRequests = 0;

  const remember = (text: string, candidates: readonly MentionCandidate[]): void => {
    cache.delete(text);
    cache.set(text, candidates);
    while (cache.size > CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  /** The decorations for one block from candidates already known to occur in it. */
  const decorate = (
    block: Block,
    text: string,
    candidates: readonly MentionCandidate[],
    excluded: ReadonlySet<string>,
  ): FoundBlock => {
    const allowed = candidates.filter((candidate) => !excluded.has(candidate.itemId));
    return {
      pos: block.pos,
      size: block.node.nodeSize,
      ranges: locateMentions(text, allowed).map((range) => ({
        from: block.pos + 1 + range.from,
        to: block.pos + 1 + range.to,
        spec: { itemId: range.itemId, title: range.title, text: text.slice(range.from, range.to) },
      })),
    };
  };

  /**
   * Everything not to underline, most important first: the note itself, then what this person
   * dismissed in this workspace, then what the note links to. The order matters only past
   * `MAX_EXCLUDED_IDS`, where the request carries the first ones and the rest are filtered here.
   */
  const excludedIds = (state: EditorState, context: MentionContext): Set<string> => {
    const excluded = new Set<string>();
    if (context.currentItemId !== undefined) excluded.add(context.currentItemId);
    for (const id of dismissedIn(context.workspaceId)) excluded.add(id);
    for (const id of linkedTargets(state.doc)) excluded.add(id);
    return excluded;
  };

  /** Puts blocks back in the queue, by a position inside each. */
  const requeue = (view: EditorView, blocks: readonly SentBlock[]): void => {
    if (blocks.length === 0) return;
    view.dispatch(
      view.state.tr
        .setMeta(unlinkedMentionsKey, {
          kind: 'requeue',
          positions: blocks.map((block) => block.pos + 1),
        } satisfies MentionMeta)
        .setMeta('addToHistory', false),
    );
  };

  const schedule = (view: EditorView, delay: number): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void run(view);
    }, delay);
  };

  const run = async (view: EditorView): Promise<void> => {
    const context = storage().context;
    if (
      !context.enabled ||
      context.find === undefined ||
      view.isDestroyed ||
      !view.editable ||
      view.composing ||
      (typeof navigator !== 'undefined' && !navigator.onLine)
    ) {
      return;
    }
    if (inFlight !== null) {
      // The answer in flight reschedules when it lands, if anything is still waiting.
      return;
    }
    const wait = Math.max(lastSentAt + MIN_INTERVAL_MS, pausedUntil) - Date.now();
    if (wait > 0) {
      schedule(view, wait);
      return;
    }

    const { state } = view;
    const mentionState = unlinkedMentionsKey.getState(state);
    if (mentionState === undefined) return;

    const candidates: Block[] = [];
    if (!initialDone) {
      initialDone = true;
      candidates.push(...leadingBlocks(state.doc, MAX_REQUEST_CHARS));
    }
    for (const pos of mentionState.dirty) {
      const block = blockAt(state.doc, pos);
      if (block !== null) candidates.push(block);
    }
    const seen = new Set<number>();
    const blocks = candidates.filter((block) => {
      if (seen.has(block.pos) || block.node.type.spec.code === true) return false;
      seen.add(block.pos);
      return true;
    });

    const excluded = excludedIds(state, context);
    const ready: FoundBlock[] = [];
    const toAsk: SentBlock[] = [];
    const remaining: number[] = [];
    const maxBlocks = soloRequests > 0 ? 1 : Infinity;
    let used = 0;
    for (const block of blocks) {
      const text = mentionText(block.node);
      const cached = cache.get(text);
      if (cached !== undefined || text.trim().length === 0) {
        ready.push(decorate(block, text, cached ?? [], excluded));
        continue;
      }
      if (
        toAsk.length >= maxBlocks ||
        (toAsk.length > 0 && used + text.length > MAX_REQUEST_CHARS)
      ) {
        // Past this request's budget: kept for the next one rather than dropped.
        remaining.push(block.pos + 1);
        continue;
      }
      toAsk.push({ pos: block.pos, text });
      used += text.length + 1;
    }
    if (toAsk.length > 0 && soloRequests > 0) soloRequests -= 1;

    view.dispatch(
      state.tr
        .setMeta(unlinkedMentionsKey, {
          kind: 'sent',
          blocks: toAsk,
          remaining,
        } satisfies MentionMeta)
        .setMeta('addToHistory', false),
    );
    if (ready.length > 0) {
      view.dispatch(
        view.state.tr
          .setMeta(unlinkedMentionsKey, { kind: 'found', blocks: ready } satisfies MentionMeta)
          .setMeta('addToHistory', false),
      );
    }
    if (toAsk.length === 0) return;

    const controller = new AbortController();
    inFlight = controller;
    lastSentAt = Date.now();
    try {
      const joined = toAsk
        .map((block) => block.text)
        .join('\n')
        .slice(0, MAX_REQUEST_CHARS);
      const answer = await context.find(
        { text: joined, excludeIds: [...excluded].slice(0, MAX_EXCLUDED_IDS) },
        controller.signal,
      );
      if (controller.signal.aborted || destroyed(view)) return;

      const found: MentionCandidate[] = answer.mentions.flatMap((mention) =>
        mention.item.title === null
          ? []
          : [{ itemId: mention.item.id, title: mention.item.title, phrase: mention.phrase }],
      );
      // A truncated answer may not have covered every block, so none is cached: what came back is
      // drawn below, and with several blocks each is asked about again alone.
      const answered = new Map<string, readonly MentionCandidate[]>();
      for (const block of toAsk) {
        const candidates = candidatesIn(block.text, found);
        answered.set(block.text, candidates);
        if (!answer.truncated) remember(block.text, candidates);
      }

      // Against the document as it is now: each sent block where it has been mapped to, and only
      // if it still says what was sent. A changed block waits for its own request.
      const current = view.state;
      const pending = unlinkedMentionsKey.getState(current)?.pending ?? [];
      const nowExcluded = excludedIds(current, storage().context);
      const results: FoundBlock[] = [];
      for (const sent of pending) {
        const block = blockAt(current.doc, sent.pos);
        if (block?.pos !== sent.pos) continue;
        const text = mentionText(block.node);
        if (text !== sent.text) continue;
        results.push(decorate(block, text, answered.get(text) ?? [], nowExcluded));
      }
      view.dispatch(
        current.tr
          .setMeta(unlinkedMentionsKey, { kind: 'found', blocks: results } satisfies MentionMeta)
          .setMeta('addToHistory', false),
      );
      if (answer.truncated && pending.length > 1) {
        soloRequests = pending.length;
        requeue(view, pending);
      }
    } catch (cause) {
      if (isNixApiError(cause) && cause.status === 429) {
        // Waited out, and nothing is lost: the refused blocks are asked about once it passes.
        const seconds = cause.retryAfterSeconds;
        pausedUntil = Date.now() + (seconds === undefined ? RATE_LIMIT_PAUSE_MS : seconds * 1000);
        if (!destroyed(view)) {
          requeue(view, unlinkedMentionsKey.getState(view.state)?.pending ?? []);
        }
      } else if (!controller.signal.aborted) {
        // A missing underline is not worth interrupting anybody for; a developer can see why.
        console.warn('The unlinked-mention lookup failed.', cause);
      }
    } finally {
      if (inFlight === controller) inFlight = null;
      if (!destroyed(view) && (unlinkedMentionsKey.getState(view.state)?.dirty.length ?? 0) > 0) {
        schedule(view, IDLE_MS);
      }
    }
  };

  return new Plugin<MentionState>({
    key: unlinkedMentionsKey,
    state: {
      init: () => ({ decorations: DecorationSet.empty, dirty: [], pending: [] }),
      apply: (transaction, value) => nextState(transaction, value),
    },
    view() {
      return {
        update(view, previous) {
          const next = unlinkedMentionsKey.getState(view.state);
          const before = unlinkedMentionsKey.getState(previous);
          if (next === undefined) return;
          // The first look, once the note has something in it - which for a synced note is after
          // the first remote update, not at mount.
          const hasContent = view.state.doc.childCount > 1 || view.state.doc.content.size > 2;
          if (!initialDone && hasContent && timer === undefined) {
            schedule(view, IDLE_MS);
            return;
          }
          if (
            next.dirty !== before?.dirty &&
            next.dirty.length > 0 &&
            view.state.doc !== previous.doc
          ) {
            schedule(view, IDLE_MS);
          }
        },
        destroy() {
          if (timer !== undefined) clearTimeout(timer);
          inFlight?.abort();
        },
      };
    },
    props: {
      decorations: (state) => unlinkedMentionsKey.getState(state)?.decorations ?? null,
    },
  });
}

export const UnlinkedMentions = Extension.create<Record<string, never>, MentionStorage>({
  name: 'unlinkedMentions',

  addStorage() {
    return { context: NO_CONTEXT };
  },

  addProseMirrorPlugins() {
    return [mentionsPlugin(() => this.storage)];
  },

  addKeyboardShortcuts() {
    return {
      // Alt+Enter: free in every keymap the editor installs. The workspace tree uses it for "open
      // beside", but only on a focused tree row, never in a note. Vim Normal mode is left alone:
      // it refuses edits from any key, and linking is an edit.
      'Alt-Enter': () => {
        if (vimStatusMode(this.editor.state) === 'normal') return false;
        const mention = activeMention(this.editor.state);
        return mention === null ? false : linkMention(this.editor, mention);
      },
    };
  },
});
