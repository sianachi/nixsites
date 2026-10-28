import { createElement, type ComponentType, type ReactNode } from 'react';

type ArtifactViewComponent = ComponentType<{ itemId: string }>;

// The app supplies the OpenUI artifact renderer, so the editor needs no openui import.
let artifactView: ArtifactViewComponent | null = null;

export function provideArtifactView(component: ArtifactViewComponent): void {
  artifactView = component;
}

/** Renders the provided artifact view, or nothing before the app has provided one. */
export function ArtifactSlot({ itemId }: { readonly itemId: string }): ReactNode {
  return artifactView === null ? null : createElement(artifactView, { itemId });
}
