import { Button, Skeleton, SkeletonLines, Text } from '@nix/ui';
import { Suspense, lazy, type ReactNode } from 'react';

import { FileViewer } from '../../files/file-viewer';
import { paneColumn, paneScroller } from '@nix/web-foundation/layout/regions';
import { PaneViewport } from '@nix/web-foundation/layout/pane-viewport';
import { LockedBody } from '../../locks/locked-body';
import type { useItemLock } from '../../locks/use-item-lock';
import { PaneProvider } from '@nix/web-platform/panes/pane-context';
import { ContainerView } from '@nix/web-views/core/container-view';
import type { View } from '@nix/web-collections/core/container-model';
import type { useContainer } from '@nix/web-collections/core/use-container';
import { SheetEditor } from '@nix/web-views/sheet/sheet-editor';
import { CompanionViewPair } from './companion-view-pair';

// Loaded at the moment somebody opens a canvas, not before: the editor is deliberately outside
// the application shell's first-load path, and a workspace of notes never needs it.
// An artifact's live view carries the OpenUI renderer, its own chunk loaded on first open.
const ArtifactView = lazy(() => import('../../openui/artifact-view'));
const CanvasEditor = lazy(async () => {
  const module = await import('@nix/web-editor/editor/canvas-editor');
  return { default: module.CanvasEditor };
});

interface ItemBodyProps {
  readonly itemId: string;
  readonly title: string;
  readonly bodyKind: string;
  readonly lockNoun: string;
  readonly lock: ReturnType<typeof useItemLock>;
  readonly lockHolderTitle: string | null;
  readonly onUnlock: (password: string) => Promise<string | null>;
  readonly showingDocument: boolean;
  readonly showChildren: boolean;
  readonly active: View | null;
  readonly views: readonly View[];
  readonly container: ReturnType<typeof useContainer>;
  readonly paneIndex: number;
  readonly proseEditor: ReactNode;
  readonly editorHostsControls: boolean;
  readonly mobileItemControls: ReactNode;
  /** The view switcher's row carries the search and options, so the primary view omits them. */
  readonly toolsInRow: boolean;
  readonly onOpen: (itemId: string) => void;
  readonly onOpenBeside?: ((itemId: string) => void) | undefined;
  readonly onOpenPinned?: ((itemId: string) => void) | undefined;
}

/** What fills the pane under the item's header: the locked state, a body, or the item's views. */
export function ItemBody({
  itemId,
  title,
  bodyKind,
  lockNoun,
  lock,
  lockHolderTitle,
  onUnlock: unlockAndFocus,
  showingDocument,
  showChildren,
  active,
  views,
  container,
  paneIndex,
  proseEditor,
  editorHostsControls,
  mobileItemControls,
  toolsInRow,
  onOpen,
  onOpenBeside,
  onOpenPinned,
}: ItemBodyProps): ReactNode {
  return (
    <div className={paneColumn}>
      {!lock.open ? (
        lock.status === 'loading' ? (
          <SkeletonLines
            label="Loading this page…"
            heading
            className="w-full max-w-3xl px-8 py-6"
          />
        ) : lock.status === 'error' ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2">
            <Text variant="note" tone="muted" role="alert">
              Could not check whether this {lockNoun} is locked.
            </Text>
            <Button variant="secondary" onClick={lock.retry}>
              Try again
            </Button>
          </div>
        ) : (
          <LockedBody
            title={title}
            noun={lockNoun}
            reason={lock.closedReason}
            holderTitle={lockHolderTitle}
            onUnlock={unlockAndFocus}
          />
        )
      ) : showingDocument ? (
        bodyKind === 'canvas' ? (
          <Suspense
            fallback={
              <div className="flex flex-1 p-4">
                <span role="status" className="sr-only">
                  Loading the canvas…
                </span>
                <Skeleton shape="block" />
              </div>
            }
          >
            <CanvasEditor
              itemId={itemId}
              cacheBody={!lock.locked}
              itemControls={editorHostsControls ? mobileItemControls : undefined}
            />
          </Suspense>
        ) : bodyKind === 'spreadsheet' ? (
          <SheetEditor
            itemId={itemId}
            cacheBody={!lock.locked}
            itemControls={editorHostsControls ? mobileItemControls : undefined}
          />
        ) : bodyKind === 'file' ? (
          <FileViewer
            itemId={itemId}
            itemControls={editorHostsControls ? mobileItemControls : undefined}
          />
        ) : bodyKind === 'artifact' ? (
          // An artifact's body holds one program: drawn live, with its own program editor.
          <Suspense
            fallback={
              <span role="status" className="sr-only">
                Loading the artifact…
              </span>
            }
          >
            <ArtifactView itemId={itemId} editable />
          </Suspense>
        ) : (
          // Every kind this build has not heard of is prose - the same open-set rule
          // the server applies, so the two never disagree about what a body is.
          proseEditor
        )
      ) : (
        <section aria-label="Container" className={paneColumn}>
          {/* A refused write is reported once, by the view that made it. The renderer knows what
          snapped back and where, which is what somebody needs; this used to draw a second
          banner saying the same thing in different words, directly under a comment claiming it
          did not. */}

          {/* The pane's scroller. It is written y-only to say what it is for, though CSS makes
              it a scroll container on both axes either way - what keeps the horizontal one
              dormant is that the view inside brings its own and this can shrink to fit around
              it. See `paneScroller`. */}
          <PaneViewport
            className={paneScroller}
            scrollKey={`${itemId}:${active?.id ?? 'children'}`}
          >
            {active === null ||
            showChildren ||
            active.companionViewId === null ||
            active.companionViewId === undefined ? (
              <ContainerView
                container={container}
                view={showChildren ? null : active}
                onOpen={onOpen}
                onOpenBeside={onOpenBeside}
                onOpenPinned={onOpenPinned}
                toolsInRow={toolsInRow}
              />
            ) : (
              <CompanionViewPair
                key={`${itemId}:${active.id}:${active.companionViewId}`}
                itemId={itemId}
                paneIndex={paneIndex}
                placement={active.companionPlacement}
                primaryName={active.name}
                companionName={
                  views.find((candidate) => candidate.id === active.companionViewId)?.name ??
                  'Companion view'
                }
                primary={
                  <ContainerView
                    container={container}
                    view={active}
                    onOpen={onOpen}
                    onOpenBeside={onOpenBeside}
                    onOpenPinned={onOpenPinned}
                    toolsInRow={toolsInRow}
                  />
                }
                companion={
                  <PaneProvider index={paneIndex + 3}>
                    <ContainerView
                      container={container}
                      view={
                        views.find((candidate) => candidate.id === active.companionViewId) ?? null
                      }
                      onOpen={onOpen}
                      onOpenBeside={onOpenBeside}
                      onOpenPinned={onOpenPinned}
                    />
                  </PaneProvider>
                }
              />
            )}
          </PaneViewport>
        </section>
      )}
    </div>
  );
}
