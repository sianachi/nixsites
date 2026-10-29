import {
  DOCUMENT_VIEW,
  type ContainerViews,
  type View,
} from '@nix/web-collections/core/container-model';

/** The id of the old "children list" shortcut that shared links may still carry. */
const CHILDREN_VIEW = '__children__';

interface ActiveViewState {
  readonly views: readonly View[];
  readonly unrenderable: readonly string[];
  readonly documentHidden: boolean;
  readonly storedDefault: string;
  readonly active: View | null;
  readonly activeId: string;
  readonly showChildren: boolean;
  readonly showingDocument: boolean;
}

/**
 * Which of an item's views is showing, given what was asked for (the address, or an embed's
 * remembered view; null for the item's own default).
 */
export function resolveActiveView(
  containerViews: ContainerViews | null,
  requested: string | null,
): ActiveViewState {
  const views = containerViews?.views ?? [];
  const unrenderable = containerViews?.unrenderable ?? [];

  // Whether the Document tab is left out. An item must never open blank, so the flag is honoured
  // only while there is a view to show instead; if every view is broken the document comes back
  // rather than leaving a pane with nothing but explanations of what went wrong.
  const documentHidden =
    containerViews?.hideDocument === true && views.some((view) => !unrenderable.includes(view.id));

  // What the item says opens, unless the request says otherwise. The request wins because it is
  // the more specific statement - somebody chose it, possibly in a link they were handed - and the
  // stored default is the starting point rather than the authority.
  const storedDefault = containerViews?.default ?? DOCUMENT_VIEW;
  const requestedId = requested ?? storedDefault;

  // While the document is hidden it can never be what is showing, whether it was asked for by the
  // address, by a stored default that should not say it, or by a view id this item does not have.
  // Core already resolves the default to the first view; this keeps the page consistent with that
  // rather than being a second opinion about it.
  const found = views.find((view) => view.id === requestedId) ?? null;
  const active: View | null =
    found !== null || !documentHidden || requestedId === CHILDREN_VIEW ? found : (views[0] ?? null);
  const activeId = active?.id ?? requestedId;

  // The body, when nothing else was chosen or when what was chosen is not a view this item has.
  // Existing shared links to the old children shortcut still open their list.
  const showChildren = activeId === CHILDREN_VIEW;
  return {
    views,
    unrenderable,
    documentHidden,
    storedDefault,
    active,
    activeId,
    showChildren,
    showingDocument: active === null && !showChildren,
  };
}
