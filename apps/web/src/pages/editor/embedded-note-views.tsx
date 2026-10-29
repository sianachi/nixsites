import { useState, type ReactNode } from 'react';

import { DOCUMENT_VIEW } from '@nix/web-collections/core/container-model';
import { useContainer } from '@nix/web-collections/core/use-container';
import { LocalViewStateContext } from '@nix/web-collections/core/view-state';
import type { EmbeddedViewsProps } from '@nix/web-editor/editor/embedded-views-slot';
import { SkeletonLines } from '@nix/ui';
import { PaneProvider } from '@nix/web-platform/panes/pane-context';
import { useSelectedItem } from '@nix/web-platform/routing/selected-item';
import { ContainerView } from '@nix/web-views/core/container-view';
import { ViewSwitcher } from '@nix/web-views/core/view-switcher';
import { resolveActiveView } from './active-view';
import { CompanionViewPair } from './companion-view-pair';

/**
 * An embedded note: its document, or any of its views, behind the same switcher the note's own
 * page has. The choice is the embed's (`viewId`), never the address, so the sort and filters of
 * these views live in a local store rather than the host page's URL.
 */
export function EmbeddedNoteViews({
  itemId,
  viewId,
  onViewChange,
  document,
}: EmbeddedViewsProps): ReactNode {
  const container = useContainer(itemId);
  const { select } = useSelectedItem();
  const [params, setParams] = useState(() => new URLSearchParams());
  const {
    views,
    unrenderable,
    documentHidden,
    storedDefault,
    active,
    activeId,
    showChildren,
    showingDocument,
  } = resolveActiveView(container.views, viewId);
  // A remembered view that has not loaded yet: the document would flash before it is replaced.
  if (container.status === 'loading' && viewId !== null && viewId !== DOCUMENT_VIEW) {
    return <SkeletonLines label="Loading this view…" className="w-full" />;
  }
  if (views.length === 0) return document;

  const open = (id: string): void => {
    select(id);
  };
  const companion =
    active?.companionViewId == null
      ? null
      : (views.find((candidate) => candidate.id === active.companionViewId) ?? null);

  return (
    <LocalViewStateContext value={{ params, setParams }}>
      <PaneProvider index={0}>
        <ViewSwitcher
          views={views}
          unrenderable={unrenderable}
          activeViewId={showingDocument ? DOCUMENT_VIEW : showChildren ? '' : activeId}
          documentLabel="Document"
          documentHidden={documentHidden}
          defaultViewId={storedDefault}
          onSelect={(chosen) => {
            setParams(new URLSearchParams());
            onViewChange(chosen);
          }}
        />
        {/* Bounded, so a long table or board scrolls inside the page that embeds it. */}
        <div className="mt-2 max-h-[32rem] min-w-0 overflow-auto">
          {showingDocument ? (
            document
          ) : companion === null || active === null ? (
            <ContainerView
              container={container}
              view={showChildren ? null : active}
              onOpen={open}
              toolsInRow={false}
            />
          ) : (
            <CompanionViewPair
              key={`${itemId}:${active.id}:${companion.id}`}
              itemId={itemId}
              paneIndex={0}
              placement={active.companionPlacement}
              primaryName={active.name}
              companionName={companion.name}
              primary={<ContainerView container={container} view={active} onOpen={open} />}
              companion={
                <PaneProvider index={3}>
                  <ContainerView container={container} view={companion} onOpen={open} />
                </PaneProvider>
              }
            />
          )}
        </div>
      </PaneProvider>
    </LocalViewStateContext>
  );
}
