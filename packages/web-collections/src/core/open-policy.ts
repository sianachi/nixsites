import type { View } from './container-model';

/** How an item activated from a view is presented. */
export type OpenMode = 'page' | 'dialog' | 'beside' | 'tab' | 'none';

/** What a view may store in `open`; null stands for Auto. */
export const OPEN_MODES: readonly OpenMode[] = ['page', 'dialog', 'beside', 'tab', 'none'];

export const OPEN_MODE_LABELS: Readonly<Record<OpenMode | 'auto', string>> = {
  auto: 'Auto',
  page: 'Full page',
  dialog: 'Dialog',
  beside: 'Beside',
  tab: 'New tab',
  none: 'None (select only)',
};

/** Kinds whose rows are a hierarchy to navigate, which Auto opens as a page. */
const HIERARCHY_KINDS: ReadonlySet<string> = new Set(['outline']);

export interface OpenContext {
  /** Only the kind and stored choice matter, so a surface that is not a saved view can pass its own. */
  readonly view: Pick<View, 'kind' | 'open'> | null;
  /** Phone-sized: every mode becomes a page. */
  readonly narrow: boolean;
  /** Whether a second pane fits and a handler exists to open one. */
  readonly canOpenBeside: boolean;
}

/**
 * The one place that decides how an activated item opens (requirements 13 and 15).
 *
 * Narrow screens always navigate: a dialog over a phone-width view is a worse page. An explicit
 * per-view choice wins next, degrading `beside` to `dialog` when there is no room for another pane;
 * `tab` needs no room, `none` makes a click select (double-click, Enter and the menu still open), and the container falls back to a plain open when its host cannot pin one.
 * Auto favours a dialog for dense browsing views, which keep their filters and scroll underneath,
 * and a page for hierarchy views, where the row is the destination.
 */
export function resolveOpenMode({ view, narrow, canOpenBeside }: OpenContext): OpenMode {
  if (narrow) return 'page';
  const stored = view?.open ?? null;
  if (stored === 'beside') return canOpenBeside ? 'beside' : 'dialog';
  if (stored === 'page' || stored === 'dialog' || stored === 'tab' || stored === 'none')
    return stored;
  // Unknown tokens from a newer build and null both mean Auto.
  if (view === null) return 'dialog';
  return HIERARCHY_KINDS.has(view.kind) ? 'page' : 'dialog';
}
