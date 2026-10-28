import { useCallback } from 'react';
import { useSearchParams } from 'react-router';

import { announce } from '@nix/web-foundation/a11y/announcer';
import { useRoomForAnotherPane } from '@nix/web-foundation/layout/viewport';
import {
  CHAT_PARAM,
  PANE_LIMIT,
  SEARCH_PARAM,
  SIZES_PARAM,
  SPLIT_PARAM,
  clearViewState,
  focusPane,
  paneFilterPrefix,
  paneParam,
  parseChatScope,
  parseSelectedItem,
  parseSizes,
  parseSplit,
  selectedItemParam,
  sizesToParam,
  splitToParam,
  type SplitOrientation,
} from './pane-params';

/**
 * Which items are open side by side, read from and written to the address.
 *
 * **The panes are a list, not a tree**, and the list is derived from the address rather than held
 * anywhere. That is the same reasoning `view-state.ts` gives for keeping a view in the URL, one
 * level up: "the spec beside the board it came from" is exactly the arrangement somebody pastes
 * into a message, and a store would make every such link open a single pane on whatever was first.
 *
 * The parameter grammar is in `pane-params.ts`; this module is what reads a whole arrangement out
 * of it and what changes one.
 */

export interface PaneState {
  /** Zero-based, and the coordinate every other parameter in this pane is suffixed with. */
  readonly index: number;
  readonly itemId: string;

  /** The conversation scope this pane shows in place of its item, when it does. */
  readonly chat?: string;
}

export interface PaneArrangement {
  readonly panes: readonly PaneState[];

  /** How many panes the address names, which exceeds `panes.length` on a narrow window. */
  readonly requested?: number;
  readonly split: SplitOrientation;

  /** Percentages, one per pane, or null to share the space equally. */
  readonly sizes: readonly number[] | null;
}

/**
 * Reads the whole arrangement. Exported so it is testable without a router.
 *
 * **A gap ends the list.** `?item=a&item3=c` is two panes' worth of parameters describing an
 * arrangement that cannot exist, so it opens `a` alone rather than guessing whether `c` was meant
 * to be second or whether a middle pane was lost. Silently renumbering would make a truncated link
 * open something nobody sent.
 *
 * A pane past {@link PANE_LIMIT} is dropped the same way a malformed identifier is, and says so.
 */
export function parsePanes(params: URLSearchParams): PaneArrangement {
  const panes: PaneState[] = [];

  for (let index = 0; index < PANE_LIMIT; index += 1) {
    const itemId = parseSelectedItem(params.get(selectedItemParam(index)), index);
    if (itemId === null) {
      break;
    }
    const chat = parseChatScope(params.get(paneParam(CHAT_PARAM, index)), index);
    panes.push(chat === null ? { index, itemId } : { index, itemId, chat });
  }

  if (params.get(selectedItemParam(PANE_LIMIT)) !== null) {
    console.warn(
      `Ignoring "${selectedItemParam(PANE_LIMIT)}": at most ${String(PANE_LIMIT)} panes may be ` +
        'open at once.',
    );
  }

  return {
    panes,
    split: parseSplit(params.get(SPLIT_PARAM)),
    sizes: parseSizes(params.get(SIZES_PARAM), panes.length),
  };
}

/** Every parameter belonging to one pane, so closing it leaves nothing of it behind. */
export function deletePane(params: URLSearchParams, index: number): void {
  params.delete(selectedItemParam(index));
  params.delete(paneParam(CHAT_PARAM, index));
  clearViewState(params, index);
}

/**
 * Moves a pane's parameters down one place.
 *
 * Closing the middle of three panes has to renumber the third, or the arrangement gains the gap
 * that {@link parsePanes} refuses to read - and the pane a person did not close would vanish.
 */
export function shiftPane(params: URLSearchParams, from: number, to: number): void {
  const bases = ['view', 'mode', 'sort', 'dir', SEARCH_PARAM, CHAT_PARAM];

  const itemId = params.get(selectedItemParam(from));
  const carried = bases.map((base) => params.get(paneParam(base, from)));

  const fromPrefix = paneFilterPrefix(from);
  const filters: [string, string][] = [];
  for (const [name, value] of params) {
    if (name.startsWith(fromPrefix)) {
      filters.push([name.slice(fromPrefix.length), value]);
    }
  }

  deletePane(params, from);
  deletePane(params, to);

  if (itemId !== null) {
    params.set(selectedItemParam(to), itemId);
  }
  for (const [offset, base] of bases.entries()) {
    const value = carried[offset];
    if (value !== null && value !== undefined) {
      params.set(paneParam(base, to), value);
    }
  }
  for (const [key, value] of filters) {
    params.append(`${paneFilterPrefix(to)}${key}`, value);
  }
}

/**
 * Closes a pane in place, renumbering whatever was after it.
 *
 * Separate from the hook so the renumbering can be exercised without a router - it is the one
 * piece of this module with enough moving parts to be wrong quietly, because a pane left at the
 * wrong index does not throw, it simply stops being read by {@link parsePanes}.
 */
export function closePaneParams(params: URLSearchParams, index: number, count: number): void {
  deletePane(params, index);

  // Every pane after the closed one moves down. Without this, closing the middle of three leaves
  // `item` and `item3`, which `parsePanes` reads as one pane - so a person closing one pane would
  // watch two of them disappear.
  for (let from = index + 1; from < count; from += 1) {
    shiftPane(params, from, from - 1);
  }

  // The ratio described the panes there were. Dropped rather than rescaled, so what is left
  // starts even instead of inheriting a split from an arrangement that no longer exists.
  params.delete(SIZES_PARAM);
}

/** Why a pane cannot be opened beside the ones already there. */
export type BesideRefusal = 'limit' | 'narrow';

/** What to say about each refusal. One place, because three call sites say it. */
export const BESIDE_REFUSAL_COPY: Readonly<Record<BesideRefusal, string>> = {
  limit: 'The most panes are already open. Close one to open another beside it.',
  narrow: 'This window is too narrow for a second pane.',
};

export interface PaneControl extends PaneArrangement {
  /**
   * Opens an item in a new pane beside the others.
   *
   * **An item already open is focused, not duplicated.** The same item in two panes means two
   * `Y.Doc`s, two sockets and two awareness entries for one document - so a person would watch
   * their own cursor follow them around as if it were a colleague's. Returns the pane the item is
   * in, so the caller can move focus there.
   *
   * At the limit this returns null and changes nothing; the control that offers it is expected to
   * be disabled, and this is the backstop rather than the message.
   */
  readonly openBeside: (itemId: string) => number | null;

  /**
   * Why another pane will not fit, or null when one will.
   *
   * Two reasons, not one boolean, because they need different words. "Close one to open another"
   * is useful at the limit and actively misleading on a narrow window, where nothing is open to
   * close and closing something would change nothing.
   */
  readonly besideRefusal: BesideRefusal | null;

  /** Whether another pane would fit, so a control can be disabled rather than silently refuse. */
  readonly canOpenBeside: boolean;

  /** Closes a pane, renumbering whatever was after it. Closing the last pane is refused. */
  readonly closePane: (index: number) => void;

  readonly setSplit: (orientation: SplitOrientation) => void;

  /** Writes the ratio. Replaces rather than pushes: a resize is not a navigation. */
  readonly setSizes: (sizes: readonly number[]) => void;
}

export function usePanes(): PaneControl {
  const [searchParams, setSearchParams] = useSearchParams();
  const roomy = useRoomForAnotherPane();
  const arrangement = parsePanes(searchParams);

  const write = useCallback(
    (mutate: (next: URLSearchParams) => void, push: boolean): void => {
      const next = new URLSearchParams(searchParams);
      mutate(next);
      setSearchParams(next, { replace: !push });
    },
    [searchParams, setSearchParams],
  );

  const refusal: BesideRefusal | null = !roomy
    ? 'narrow'
    : arrangement.panes.length >= PANE_LIMIT
      ? 'limit'
      : null;

  const openBeside = useCallback(
    (itemId: string): number | null => {
      const existing = arrangement.panes.find((pane) => pane.itemId === itemId);
      if (existing !== undefined) {
        // Already open. Moving focus there is the whole response - without it the control looks
        // broken, because refusing to duplicate and doing nothing are indistinguishable.
        announce(`Already open in pane ${String(existing.index + 1)}.`);
        focusPane(existing.index);
        return existing.index;
      }

      // Refused here rather than only at the controls. A caller that routed around the check -
      // the modifier-click did - would write a pane into the address that nothing draws, announce
      // that it had opened, and move focus to an element that does not exist, which loses focus to
      // the document body entirely. The gate belongs with the state.
      if (refusal !== null) {
        announce(BESIDE_REFUSAL_COPY[refusal]);
        return null;
      }

      const index = arrangement.panes.length;
      announce(`Opened in pane ${String(index + 1)} of ${String(index + 1)}.`);
      focusPane(index);
      write((next) => {
        next.set(selectedItemParam(index), itemId);
        // The ratio described the panes there were, not the panes there now are. Dropped rather
        // than rescaled, so the new arrangement starts even instead of inheriting a split from an
        // arrangement that no longer exists.
        next.delete(SIZES_PARAM);
      }, true);

      return index;
    },
    [arrangement.panes, refusal, write],
  );

  const closePane = useCallback(
    (index: number): void => {
      // Refused rather than allowed to empty the screen. "Close" on the only pane would leave the
      // shell with nothing open and no way back except the tree, which is not what the control
      // means - it means "this one, not the others".
      if (arrangement.panes.length <= 1 || index >= arrangement.panes.length) {
        return;
      }

      write((next) => {
        closePaneParams(next, index, arrangement.panes.length);
      }, true);
    },
    [arrangement.panes.length, write],
  );

  const setSplit = useCallback(
    (orientation: SplitOrientation): void => {
      write((next) => {
        next.set(SPLIT_PARAM, splitToParam(orientation));
      }, false);
    },
    [write],
  );

  const setSizes = useCallback(
    (sizes: readonly number[]): void => {
      write((next) => {
        next.set(SIZES_PARAM, sizesToParam(sizes));
      }, false);
    },
    [write],
  );

  return {
    ...arrangement,
    // The address is left exactly as it is on a narrow window - only what is *drawn* narrows, so
    // the same link re-expands to its full arrangement on a wide screen. Discarding the panes here
    // would mean opening a colleague's link on a phone silently rewrote it.
    panes: roomy ? arrangement.panes : arrangement.panes.slice(0, 1),

    // How many the address asks for, which is not always how many are drawn. A narrow window
    // shows one and keeps the rest in the URL, and the screen owes the reader a word about that
    // rather than quietly showing them less than they were sent.
    requested: arrangement.panes.length,
    besideRefusal: refusal,
    canOpenBeside: refusal === null,
    openBeside,
    closePane,
    setSplit,
    setSizes,
  };
}
