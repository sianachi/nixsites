/**
 * How a pane's state is named in the address.
 *
 * **The first pane keeps today's parameter names, unprefixed.** `?item=...&view=...&f.status=open`
 * means exactly what it meant before panes existed, so every link anybody has ever been sent still
 * opens the thing it named. Later panes carry a one-based suffix: `item2`, `view2`, `f2.status`.
 * There is no `item1`, and reading one is not an error - it is simply not a name this grammar
 * mints, so it is ignored like any other unrecognised parameter.
 *
 * **A suffix rather than one packed parameter**, for the reason `view-state.ts` already gives for
 * spelling filters `f.<key>=<value>`: somebody can read the link and see what it opens. A nested
 * split encoded into a string would be the opposite, which is also why the grammar has no way to
 * express one - see {@link PANE_LIMIT}.
 *
 * The filter prefix is `f2.` rather than `f.2.` so that the existing scan in `parseFilters` stays
 * a single `startsWith`, and so pane one's filters cannot be confused with a property whose key
 * happens to begin with a digit.
 */

/**
 * How many panes may be open at once.
 *
 * Three. The shell already spends a fixed 264px on the tree and up to 340px on the settings panel;
 * on a 1440px screen a fourth pane leaves each one narrower than the measure `max-w-prose` exists
 * to protect, so the limit is what the layout can honestly show rather than a round number.
 */
export const PANE_LIMIT = 3;

/**
 * What a pane shows instead of its item: the companion conversation, `chat=workspace` or
 * `chat=<note id>` (`chat2`, `chat3` in later panes). The item stays in the address so the pane
 * exists and Back returns to it; selecting any item in the pane drops the chat
 * (`writeSelectedItem`). The value is a scope, not a thread: a scope has exactly one live
 * conversation, so a chat tab keeps showing it however it is archived or resumed.
 */
export const CHAT_PARAM = 'chat';

const CHAT_SCOPE = /^(workspace|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Reads a pane's chat scope; anything but `workspace` or an item id is dropped, as the address is hostile. */
export function parseChatScope(raw: string | null, pane = 0): string | null {
  if (raw === null || raw.length === 0) {
    return null;
  }
  if (!CHAT_SCOPE.test(raw)) {
    console.warn(`Ignoring unrecognised "${paneParam(CHAT_PARAM, pane)}" search parameter:`, raw);
    return null;
  }
  return raw;
}

/** Which way the panes are laid out. */
export const SPLIT_PARAM = 'split';

/** The ratio between them, as percentages, one per pane. */
export const SIZES_PARAM = 'sizes';

export type SplitOrientation = 'vertical' | 'horizontal';

/**
 * One orientation for the whole group, not a tree.
 *
 * A nested split needs a structure encoded into the query string, which is the packed-parameter
 * shape this grammar exists to avoid. If nesting is ever wanted it is a different design and a new
 * decision, not a fourth value here.
 */
export const DEFAULT_SPLIT: SplitOrientation = 'vertical';

/**
 * The name a base parameter takes in a given pane.
 *
 * @param base the unprefixed name, as pane one spells it
 * @param index zero-based
 */
export function paneParam(base: string, index: number): string {
  return index === 0 ? base : `${base}${String(index + 1)}`;
}

/** The filter prefix for a pane: `f.` in the first, `f2.` in the second. */
export function paneFilterPrefix(index: number): string {
  return index === 0 ? 'f.' : `f${String(index + 1)}.`;
}

/**
 * Reads the split orientation, falling back rather than failing.
 *
 * A malformed value is a link that drifted, which is worth a line in the console: the alternative
 * is a person reporting that their split link "sometimes" opens the wrong way round.
 */
export function parseSplit(raw: string | null): SplitOrientation {
  if (raw === null || raw.length === 0) {
    return DEFAULT_SPLIT;
  }

  if (raw === 'v' || raw === 'vertical') {
    return 'vertical';
  }

  if (raw === 'h' || raw === 'horizontal') {
    return 'horizontal';
  }

  console.warn(`Ignoring unrecognised "${SPLIT_PARAM}" search parameter:`, raw);
  return DEFAULT_SPLIT;
}

/** What a split orientation is written as. The short form, because a person reads this. */
export function splitToParam(orientation: SplitOrientation): string {
  return orientation === 'horizontal' ? 'h' : 'v';
}

/**
 * Reads the pane ratio, or null to share the space equally.
 *
 * Null rather than a default array because "equal" has to survive a pane being opened or closed:
 * a stored `50,50` would be wrong the moment a third pane appeared, and guessing which two of the
 * three it described is not something a reader of the URL should have to do either.
 *
 * A ratio that does not describe `count` panes is discarded whole. Rescaling a two-pane ratio onto
 * three panes would be inventing a layout nobody chose.
 */
export function parseSizes(raw: string | null, count: number): readonly number[] | null {
  if (raw === null || raw.length === 0) {
    return null;
  }

  const parts = raw.split(',').map((part) => Number(part.trim()));
  if (parts.length !== count || parts.some((part) => !Number.isFinite(part) || part <= 0)) {
    console.warn(`Ignoring unusable "${SIZES_PARAM}" search parameter:`, raw);
    return null;
  }

  return parts;
}

/** Writes a ratio, rounded, because a URL does not need six decimal places of a drag. */
export function sizesToParam(sizes: readonly number[]): string {
  return sizes.map((size) => String(Math.round(size * 10) / 10)).join(',');
}

/**
 * The id a pane's region carries, so focus can be moved to it from outside the pane.
 *
 * A DOM id rather than a ref registry: the two things that need to move focus into a pane are the
 * tree (which opens one) and a sibling pane (which closes itself), and neither is anywhere near
 * the element in the component tree. Threading refs up and back down would be a lot of plumbing
 * for one `focus()`.
 */
export function paneElementId(index: number): string {
  return `nix-pane-${String(index)}`;
}

/**
 * Moves focus into a pane.
 *
 * Deferred a frame, because every caller changes the address first and the element being focused
 * may not exist until React has rendered the arrangement that resulted.
 */
export function focusPane(index: number): void {
  requestAnimationFrame(() => {
    document.getElementById(paneElementId(index))?.focus();
  });
}

// Parameter names and URL helpers below sit here, not with their features, so routing and views can
// both build on panes without panes reaching back up to them.

export const VIEW_PARAM = 'view';
export const MODE_PARAM = 'mode';
export const SORT_PARAM = 'sort';
export const DIRECTION_PARAM = 'dir';
export const SEARCH_PARAM = 'search';

/**
 * Strips every parameter that belongs to the item being left.
 *
 * A view id, a sort and a filter set all name properties of one item's configuration. Carried onto
 * a different item they are at best meaningless - that item has no view by that id, so it falls
 * back to its body - and at worst wrong, because two items can easily both have a view called
 * `by-status` and the second would open on a board nobody asked for, sorted by a property it may
 * not have.
 *
 * Exported so item navigation can call it. It lives here rather than there because this module owns
 * the parameter names, and a second list of them somewhere else is a list that goes stale.
 *
 * **Scoped to one pane.** Deleting the unprefixed names unconditionally - which is what this did
 * before there were panes, and what a naive port would have kept doing - means navigating in the
 * second pane silently discards the first pane's view, sort and filters. That is the single most
 * likely defect in this whole area, so it has a test of its own.
 */
export function clearViewState(params: URLSearchParams, pane = 0): void {
  params.delete(paneParam(VIEW_PARAM, pane));
  params.delete(paneParam(MODE_PARAM, pane));
  params.delete(paneParam(SORT_PARAM, pane));
  params.delete(paneParam(DIRECTION_PARAM, pane));
  params.delete(paneParam(SEARCH_PARAM, pane));

  const prefix = paneFilterPrefix(pane);
  for (const name of [...params.keys()]) {
    if (name.startsWith(prefix)) {
      params.delete(name);
    }
  }
}

export const SELECTED_ITEM_PARAM = 'item';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads one raw parameter value. Exported so it is testable without a router.
 *
 * A value that is not an identifier is dropped rather than passed on: the URL is the most hostile
 * runtime boundary there is, anybody can type into it, and a malformed one should leave the shell
 * with nothing open rather than sending a nonsense identifier to Core.
 */
export function parseSelectedItem(raw: string | null, pane = 0): string | null {
  if (raw === null || raw.length === 0) {
    return null;
  }

  if (!UUID.test(raw)) {
    console.warn(
      `Ignoring unrecognised "${paneParam(SELECTED_ITEM_PARAM, pane)}" search parameter:`,
      raw,
    );
    return null;
  }

  return raw;
}

/** The name of the parameter naming a pane's open item. */
export function selectedItemParam(pane: number): string {
  return paneParam(SELECTED_ITEM_PARAM, pane);
}
