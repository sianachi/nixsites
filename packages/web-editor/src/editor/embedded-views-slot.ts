import { createElement, type ComponentType, type ReactNode } from 'react';

export interface EmbeddedViewsProps {
  readonly itemId: string;
  /** The embed's remembered view, or null for the note's own default. */
  readonly viewId: string | null;
  readonly onViewChange: (viewId: string | null) => void;
  /** The note's live body, shown when the document tab is chosen. */
  readonly document: ReactNode;
}

// The app supplies the views (the editor must not import web-views), as with the artifact slot.
let embeddedViews: ComponentType<EmbeddedViewsProps> | null = null;

export function provideEmbeddedViews(component: ComponentType<EmbeddedViewsProps>): void {
  embeddedViews = component;
}

/** Renders the provided views, or just the document before the app has provided any. */
export function EmbeddedViewsSlot(props: EmbeddedViewsProps): ReactNode {
  return embeddedViews === null ? props.document : createElement(embeddedViews, props);
}
