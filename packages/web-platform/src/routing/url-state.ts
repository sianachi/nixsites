import { useSearchParams } from 'react-router';
import { z } from 'zod';

/**
 * The URL-state convention for @nix/web.
 *
 * The state ladder (engineering plan section 4.2) puts the URL on rung two,
 * above local `useState`: anything that should survive a refresh or be
 * shareable as a link lives in the router. Nix is a document workspace, so
 * deep links are a feature, not a nicety - the selected item, the active view,
 * a search query and a filter set all belong here.
 *
 * The convention this module establishes, and that later features follow:
 *
 *   1. One Zod schema per parameter, exported next to the feature that owns
 *      it. The URL is a runtime boundary like any other, and it is the most
 *      hostile one - anybody can type into it.
 *   2. The reader always returns a valid value. A malformed parameter falls
 *      back to the documented default and is reported; it never throws a
 *      shared link into an error state, and it never silently swallows the
 *      mismatch either.
 *   3. Writers replace rather than push for view toggles, so a segmented
 *      control does not fill the back button with history entries. Navigation
 *      that a user would expect Back to undo pushes instead.
 *   4. Prefer a real <Link> over a programmatic setter where the control is
 *      semantically a link: it stays right-clickable, copyable and shareable.
 *      The setter exists for the cases where an action, not a link, changes
 *      the view - a retry button, for instance.
 */

/** The state-pattern gallery on the tokens page is driven entirely by this. */
export const StatePreviewSchema = z.enum(['ready', 'loading', 'empty', 'error', 'partial']);

export type StatePreview = z.infer<typeof StatePreviewSchema>;

export const STATE_PREVIEW_PARAM = 'state';

export const DEFAULT_STATE_PREVIEW: StatePreview = 'ready';

export const STATE_PREVIEWS: readonly StatePreview[] = StatePreviewSchema.options;

/**
 * Parses one raw search-parameter value. Exported so it is unit-testable
 * without a router, and so other modules copy the shape rather than the
 * mistake.
 */
export function parseStatePreview(raw: string | null): StatePreview {
  if (raw === null) {
    return DEFAULT_STATE_PREVIEW;
  }
  const result = StatePreviewSchema.safeParse(raw);
  if (result.success) {
    return result.data;
  }
  // Not a silent fallback: an unparseable URL is worth knowing about, because
  // it usually means a link we generated somewhere else has drifted. This
  // becomes a telemetry event once the telemetry client lands.
  console.warn(`Ignoring unrecognised "${STATE_PREVIEW_PARAM}" search parameter:`, raw);
  return DEFAULT_STATE_PREVIEW;
}

/** Builds the search string for a preview, for use as a <Link> target. */
export function statePreviewSearch(preview: StatePreview): string {
  return `?${new URLSearchParams({ [STATE_PREVIEW_PARAM]: preview }).toString()}`;
}

interface StatePreviewControl {
  readonly preview: StatePreview;
  readonly setPreview: (next: StatePreview) => void;
}

export function useStatePreview(): StatePreviewControl {
  const [searchParams, setSearchParams] = useSearchParams();
  const preview = parseStatePreview(searchParams.get(STATE_PREVIEW_PARAM));

  const setPreview = (next: StatePreview): void => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set(STATE_PREVIEW_PARAM, next);
    setSearchParams(nextParams, { replace: true });
  };

  return { preview, setPreview };
}
