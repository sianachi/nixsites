import {
  Listbox,
  placeFloatingMenu,
  readViewportBounds,
  useListbox,
  type ListboxOption,
} from '@nix/ui';
import { FileText } from 'lucide-react';
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/react';

import { useApiClient } from '../api/api-client-provider';
import { frecencyScores, recordPick } from '../lib/frecency';
import { choiceOrderOn } from '../settings/editor/suggestion-preferences';
import { rankReferences } from '../lib/suggest/rank-references';
import {
  fetchCandidates,
  itemSearchEmptyMessage,
  RESULT_LIMIT,
  useItemSearch,
  type SearchHit,
} from './item-search';
import {
  coCitationSource,
  RELATED_WAIT_MS,
  withinWait,
  type CoCitationSource,
} from './related-items';
import { useEditorListbox, useEditorTrigger } from './trigger-menu';

// Where the pool size used to live; the ranking test and other callers still import it from here.
export { CANDIDATE_POOL } from './item-search';

/**
 * The reference picker: `[[` and `@`, an item search, and a `reference` node.
 *
 * **One picker for both triggers.** They differ in what they offer, not in what they produce: `[[`
 * is items, `@` is items and people. The node is the same either way, which is why
 * `@nix/editor-schema` defines one - two would be two schema entries, two fixtures and two
 * migrations to say the same thing twice.
 *
 * **Focus never leaves the document, and the query is never held here.** The trigger and what has
 * been typed after it are read out of the document on every transaction, so the picker survives
 * everything a component-held query does not: clicking away and back, a colleague's edit arriving
 * through the CRDT and shifting every position, undo. It is also the only arrangement that works
 * at all - a field of its own would take the focus, and the next character typed would go into the
 * picker instead of into the note.
 *
 * The slash menu now takes exactly this shape too - it held its query in a field of its own once,
 * and both of the bugs that design produced are written up on `SlashMenu` itself.
 *
 * **The search is the server's, not the loaded tree's.** The sidebar fetches children per folder
 * on expansion, so a client-side filter can only see what somebody has already clicked open -
 * which for a picker means the item you are trying to link to is usually the one it cannot find.
 */

/**
 * How far into a trigger somebody can type before it stops being a link and starts being prose.
 *
 * Exported for the slash menu, which reads the same size of window out of the document: its
 * deferral to this picker only works if it can see every trigger this picker can.
 */
export const MAX_QUERY = 64;

/**
 * The most nodes read when collecting what this note already links to.
 *
 * The scan runs once per search answer, not per keystroke, and stops here so a very long note
 * costs a bounded walk: the links it misses past the budget only lose a small ranking boost.
 */
const LINK_SCAN_BUDGET = 20_000;

/** The frecency namespace for links made in one workspace. Picks never rank another workspace. */
export function linkFrecencyNamespace(workspaceId: string): string {
  return `links:${workspaceId}`;
}

/**
 * The ids of the items `doc` already references, reading at most `budget` nodes.
 *
 * Exported for its own tests.
 */
export function linkedTargets(
  doc: ProseMirrorNode,
  budget: number = LINK_SCAN_BUDGET,
): ReadonlySet<string> {
  const targets = new Set<string>();
  let visited = 0;
  doc.descendants((node) => {
    visited += 1;
    if (visited > budget) {
      return false;
    }
    if (node.type.name === 'reference') {
      const target: unknown = node.attrs.targetId;
      if (typeof target === 'string' && target.length > 0) {
        targets.add(target);
      }
      return false;
    }
    return true;
  });
  return targets;
}

/** An open trigger: where its text starts, what has been typed into it, and which kind it is. */
export interface FoundTrigger {
  readonly start: number;
  readonly query: string;
  readonly kind: 'item' | 'principal';
}

/**
 * Finds an open `[[` or `@` in the text before the caret.
 *
 * A trigger only counts at the start of a word - after whitespace, or at the very start - so an
 * email address does not open a people picker and `a[[b` stays text. A newline or a closing
 * bracket ends it, and so does a query longer than anybody would type into a link: past that
 * ceiling this is somebody who wrote `[[` and carried on with a paragraph.
 *
 * Exported for its own tests: it is pure string handling, and the alternative is asserting it
 * through an editor, a document and a selection.
 */
export function findTrigger(text: string, truncated = false): FoundTrigger | null {
  const brackets = text.lastIndexOf('[[');
  const at = text.lastIndexOf('@');

  const start = Math.max(brackets, at);
  if (start < 0) {
    return null;
  }

  const isBrackets = start === brackets;

  // Position zero is the start of a word only when it really is the start of the block. When the
  // caller handed over a window cut out of a longer paragraph, the character before it is unknown -
  // and guessing "whitespace" would turn the middle of an email address into a people picker.
  const before = start === 0 ? (truncated ? undefined : ' ') : text[start - 1];
  if (before === undefined || !/\s/.test(before)) {
    return null;
  }

  const query = text.slice(start + (isBrackets ? 2 : 1));
  if (query.length > MAX_QUERY || /[\n\]]/.test(query)) {
    return null;
  }

  return { start, query, kind: isBrackets ? 'item' : 'principal' };
}

export interface ReferenceMenuProps {
  readonly editor: Editor;
  /**
   * The workspace the note belongs to. Scopes the pick history that ranks candidates; without it
   * the picker still works and shows the server's order adjusted only by this note's own links.
   */
  readonly workspaceId?: string | undefined;
  /** The note being written in, for the re-rank's placement and co-citation signals. */
  readonly itemId?: string | undefined;
  /**
   * The note's parent, as the page already knows it from the workspace tree: `null` at a
   * workspace root, `undefined` when unknown. Ranks the note's siblings and parent a little higher.
   */
  readonly parentId?: string | null | undefined;
}

export function ReferenceMenu({
  editor,
  workspaceId,
  itemId,
  parentId,
}: ReferenceMenuProps): ReactNode {
  const client = useApiClient();
  // One co-citation source per note, created and disposed with it. A ref because only effects
  // read it - it never decides what renders.
  const coCitations = useRef<CoCitationSource | null>(null);
  useEffect(() => {
    if (itemId === undefined) {
      return;
    }
    const source = coCitationSource(client, itemId);
    coCitations.current = source;
    return () => {
      source.dispose();
      coCitations.current = null;
    };
  }, [client, itemId]);
  const { trigger, open, dismiss } = useEditorTrigger(editor, MAX_QUERY + 2, findTrigger);
  const query = trigger?.query ?? '';

  // Opening the picker is when co-citations are first worth having; the request starts now, so it
  // has usually landed by the time enough has been typed to search.
  useEffect(() => {
    if (open) {
      void coCitations.current?.get();
    }
  }, [open]);

  // The ranking step on top of the shared search. Its identity is an effect dependency of
  // `useItemSearch`, so it changes only with the inputs it ranks against.
  const find = useCallback(
    async (text: string, signal: AbortSignal): Promise<readonly SearchHit[]> => {
      const related = withinWait(
        coCitations.current?.get() ?? Promise.resolve(undefined),
        RELATED_WAIT_MS,
      );
      const candidates = await fetchCandidates(client, text, signal);
      const coCited = await related;
      if (signal.aborted) {
        return [];
      }
      // Ranked once, here, against the document and the pick history as they stand when the
      // answer arrives - not on every render. The order then holds still while somebody
      // arrows through it, which a ranking recomputed per transaction could not promise.
      const ranked = rankReferences(
        candidates,
        {
          query: text,
          frecency:
            workspaceId === undefined || !choiceOrderOn()
              ? undefined
              : frecencyScores(linkFrecencyNamespace(workspaceId)),
          linkedHere: linkedTargets(editor.state.doc),
          currentItemId: itemId,
          currentParentId: parentId,
          coCited,
        },
        RESULT_LIMIT,
      );
      return ranked.map((entry) => entry.candidate);
    },
    [client, editor, itemId, parentId, workspaceId],
  );
  const { hits, failed, answered } = useItemSearch(open ? query : null, find);

  const options: readonly ListboxOption[] = hits.map((hit) => ({
    id: hit.id,
    label: hit.title ?? 'Untitled',
    icon: FileText,
  }));

  const listbox = useListbox(options, (_option, index) => {
    const hit = hits[index];
    if (hit === undefined || trigger === null) {
      return;
    }

    // The trigger's text and the node go in one chain, so the document never holds a state where
    // the `[[` has gone and the reference has not arrived - which through the CRDT would be an
    // update every other client applies.
    editor
      .chain()
      .focus()
      .deleteRange({ from: trigger.from, to: trigger.to })
      .insertContent([
        {
          type: 'reference',
          attrs: { kind: trigger.kind, targetId: hit.id, label: hit.title ?? 'Untitled' },
        },
        { type: 'text', text: ' ' },
      ])
      .run();

    // Remembered by id only, in this workspace's namespace: the next search in this workspace
    // ranks it higher, and no other workspace's picker ever sees it.
    if (workspaceId !== undefined && choiceOrderOn()) {
      recordPick(linkFrecencyNamespace(workspaceId), hit.id);
    }
  });

  useEditorListbox(editor, listbox, trigger, open, dismiss);

  if (trigger === null || !open) {
    return null;
  }

  // Below the caret at up to 320px wide, unless the viewport has no room for that - the same
  // clamp `SlashMenu` uses, because both pickers share the fixed-width-below-the-caret problem.
  const placement = placeFloatingMenu(
    { left: trigger.left, top: trigger.top, bottom: trigger.bottom },
    320,
    readViewportBounds(),
  );

  const menuPosition = {
    left: placement.left,
    top: placement.top,
    width: placement.maxWidth,
    maxHeight: placement.maxHeight,
  };
  return (
    <div
      // Positioned against the caret in viewport coordinates, so it follows the text rather than
      // the scroller - which the editor does under it.
      style={menuPosition} // design-token-exempt: a caret's position is a runtime measurement, not a scale step.
      className={[
        'fixed z-20 flex flex-col overflow-y-auto border border-divider bg-background shadow-md',
        placement.above ? '-mb-1 -translate-y-full' : 'mt-1',
      ].join(' ')}
    >
      <Listbox
        label={trigger.kind === 'principal' ? 'Items and people to link to' : 'Items to link to'}
        options={options}
        controller={listbox}
        emptyMessage={itemSearchEmptyMessage(query, { failed, answered })}
      />
    </div>
  );
}
