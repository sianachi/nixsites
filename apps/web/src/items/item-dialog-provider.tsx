import { Button, Dialog, Text } from '@nix/ui';
import { useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { OpenItem } from '../pages/editor-page';
import { PaneProvider } from '@nix/web-platform/panes/pane-context';
import { useOpenItem } from '../tabs/use-open-item';
import { useTemplateLibrary } from '@nix/web-templates/templates/template-library-context';
import { LocalViewStateContext } from '@nix/web-collections/core/view-state';
import type { WorkspaceTree } from '@nix/web-collections/items/use-workspace-tree';
import {
  ItemDialogContext,
  type ItemDialogContextView,
} from '@nix/web-foundation/lib/item-dialog-context';
import { paneScroller } from '@nix/web-foundation/layout/regions';
import { ContextFields } from './context-fields';
import { EventBrief } from './event-brief';
import { DependenciesPanel } from './dependencies-panel';
import { GalleryReview } from './gallery-review';

export function ItemDialogProvider({
  tree,
  children,
}: {
  readonly tree: WorkspaceTree;
  readonly children: ReactNode;
}): ReactNode {
  const location = useLocation();
  return (
    <ItemDialogSession key={location.pathname} tree={tree}>
      {children}
    </ItemDialogSession>
  );
}

function ItemDialogSession({
  tree,
  children,
}: {
  readonly tree: WorkspaceTree;
  readonly children: ReactNode;
}): ReactNode {
  const [stack, setStack] = useState<{ itemId: string; view: ItemDialogContextView | undefined }[]>(
    [],
  );
  const { openPreview } = useOpenItem();
  function open(itemId: string, view?: ItemDialogContextView): void {
    setStack((current) => {
      const index = current.findIndex((entry) => entry.itemId === itemId);
      return index === -1 ? [...current, { itemId, view }] : current.slice(0, index + 1);
    });
    void tree.reveal(itemId);
  }
  return (
    <ItemDialogContext value={open}>
      {children}
      {stack.map(({ itemId, view }, index) => (
        <ItemDialog
          key={itemId}
          itemId={itemId}
          view={view}
          tree={tree}
          onClose={() => {
            setStack((current) => current.slice(0, index));
          }}
          onOpen={open}
          onStep={(nextId) => {
            setStack((current) => [...current.slice(0, index), { itemId: nextId, view }]);
            void tree.reveal(nextId);
          }}
          onNavigateAway={() => {
            setStack([]);
          }}
          onPage={() => {
            setStack([]);
            openPreview(itemId);
          }}
        />
      ))}
    </ItemDialogContext>
  );
}

function ItemDialog({
  itemId,
  view,
  tree,
  onClose,
  onOpen,
  onStep,
  onPage,
  onNavigateAway,
}: {
  readonly itemId: string;
  readonly view: ItemDialogContextView | undefined;
  readonly tree: WorkspaceTree;
  readonly onClose: () => void;
  readonly onOpen: (itemId: string) => void;
  readonly onStep: (itemId: string) => void;
  readonly onPage: () => void;
  readonly onNavigateAway: () => void;
}): ReactNode {
  const [params, setParams] = useState(() => new URLSearchParams());
  const templates = useTemplateLibrary();
  const item = tree.find(itemId);
  const reveal = tree.revealOf(itemId);
  const record = view?.kind === 'record' ? view : null;
  const event = view?.kind === 'event' ? view : null;
  const dependencies = view?.kind === 'dependencies' ? view : null;
  const review = view?.kind === 'review' ? view : null;
  const contextLabel =
    record !== null
      ? 'Record detail'
      : event !== null
        ? 'Event brief'
        : dependencies !== null
          ? 'Dependencies'
          : review !== null
            ? 'Gallery review'
            : null;
  const rows = record?.rows ?? review?.rows ?? [];
  const position = rows.indexOf(itemId);
  const previous = position > 0 ? rows[position - 1] : undefined;
  const next = position >= 0 ? rows[position + 1] : undefined;
  const noun = review === null ? 'record' : 'asset';
  return (
    <Dialog
      open
      title={item !== null && item.title.length > 0 ? item.title : 'Item'}
      onClose={onClose}
      closeLabel="Close item"
      presentation="workspace"
      titleHidden
      actions={
        <>
          {previous === undefined ? null : (
            <Button
              variant="secondary"
              onClick={() => {
                onStep(previous);
              }}
            >
              Previous {noun}
            </Button>
          )}
          {next === undefined ? null : (
            <Button
              variant="secondary"
              onClick={() => {
                onStep(next);
              }}
            >
              Next {noun}
            </Button>
          )}
          <Button variant="secondary" onClick={onPage}>
            Open as page
          </Button>
        </>
      }
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {item === null ? (
          <div className="p-6">
            <Text as="p">
              {reveal === 'failed'
                ? 'This item could not be loaded.'
                : reveal === 'forbidden'
                  ? "You can't view this item."
                  : reveal === 'missing'
                    ? 'This item is unavailable.'
                    : 'Loading item…'}
            </Text>
            {reveal === 'failed' ? (
              <Button
                onClick={() => {
                  void tree.retryReveal(itemId);
                }}
              >
                Try again
              </Button>
            ) : null}
          </div>
        ) : (
          <PaneProvider index={0}>
            <LocalViewStateContext value={{ params, setParams }}>
              <OpenItem
                tree={tree}
                itemId={item.id}
                title={item.title}
                bodyKind={item.type}
                defaultToComments={view?.kind === 'comments'}
                contextView={
                  contextLabel === null
                    ? undefined
                    : {
                        label: contextLabel,
                        render: (details) => (
                          <section aria-label={contextLabel} className={paneScroller}>
                            <div
                              className={`mx-auto flex w-full flex-col gap-4 p-4 sm:p-6 ${review === null ? 'max-w-3xl' : 'max-w-6xl'}`}
                            >
                              <Text as="h2" variant="h5">
                                {contextLabel}
                              </Text>
                              {record !== null ? (
                                <ContextFields details={details} fields={record.fields} />
                              ) : null}
                              {event !== null ? (
                                <EventBrief details={details} view={event} />
                              ) : null}
                              {dependencies !== null ? (
                                <DependenciesPanel
                                  details={details}
                                  view={dependencies}
                                  onOpen={onStep}
                                />
                              ) : null}
                              {review !== null ? (
                                <GalleryReview details={details} view={review} />
                              ) : null}
                            </div>
                          </section>
                        ),
                      }
                }
                canManageTemplates={templates.capabilities.canManage}
                canApplyTemplates={templates.templates.some(
                  (template) => template.capabilities.canApply,
                )}
                onOpen={onOpen}
                onClose={undefined}
                onNavigateAway={onNavigateAway}
                onCommit={() => undefined}
              />
            </LocalViewStateContext>
          </PaneProvider>
        )}
      </div>
    </Dialog>
  );
}
