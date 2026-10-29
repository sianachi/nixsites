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

  // The flag is honoured only while some view can render, so an item never opens blank.
  const documentHidden =
    containerViews?.hideDocument === true && views.some((view) => !unrenderable.includes(view.id));

  // The request (possibly from a shared link) wins over the stored default.
  const storedDefault = containerViews?.default ?? DOCUMENT_VIEW;
  const requestedId = requested ?? storedDefault;

  // A hidden document can never be what shows; fall back to the first view, as Core does.
  const found = views.find((view) => view.id === requestedId) ?? null;
  const active: View | null =
    found !== null || !documentHidden || requestedId === CHILDREN_VIEW ? found : (views[0] ?? null);
  const activeId = active?.id ?? requestedId;

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
