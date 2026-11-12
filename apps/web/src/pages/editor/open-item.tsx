import { Button, Dialog, Icon, Menu, Text, type MenuEntry } from '@nix/ui';
import { useBookmarksStore, useIsKept } from '@nix/web-collections/items/use-bookmarks';
import { MoreHorizontal, Settings2, Maximize2, Plus, Sparkles, Star } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { useAuth } from '@nix/web-platform/auth/auth-provider';
import { BookmarkButton } from '../../bookmarks/bookmark-button';
import { DailyNoteBar } from '../../daily-notes/daily-note-bar';
import { parseDailyNoteDate } from '../../daily-notes/daily-note';
import { NoteEditor } from '@nix/web-editor/editor/note-editor';
import { useHiddenItems } from '@nix/web-collections/items/use-hidden-items';
import { paneClip, paneScroller } from '@nix/web-foundation/layout/regions';
import { useNarrowViewport, useOverlayDetails } from '@nix/web-foundation/layout/viewport';
import { useForgetLockedBody } from '../../locks/use-forget-locked-body';
import { useItemLock } from '../../locks/use-item-lock';
import { toggleZenMode, useZenActive } from '@nix/web-foundation/lib/zen-mode';
import { usePaneIndex } from '@nix/web-platform/panes/pane-context';
import { TOGGLE_ITEM_PANEL_EVENT } from '../../panel/panel-state';
import type { Pane } from '../../panel/item-panel';
import { useItemProperties } from '@nix/web-collections/properties/use-item-properties';
import { useSitesVisible } from '@nix/web-settings/settings/publishing/publishing-preference';
import type { ShellContext } from '../../shell/shell-context';

import { focusSitePaneHeading } from '@nix/web-sites/sites/site-pane';
import { useItemHasSite } from '@nix/web-sites/sites/use-item-site';
import { useOpenChat } from '@nix/web-pets/pets/use-open-chat';
import { DOCUMENT_VIEW } from '@nix/web-collections/core/container-model';
import { ContainerViewTools } from '@nix/web-views/core/container-view';
import { useContainer } from '@nix/web-collections/core/use-container';
import { useViewState } from '@nix/web-collections/core/view-state';
import { COMMENTS_VIEW, ViewSwitcher } from '@nix/web-views/core/view-switcher';
import { useRememberSmartList } from '@nix/web-views/query/known-smart-lists';
import { useOptionalWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { STRUCTURED_RECIPES } from '@nix/structure-spec';
import { itemActionEntries } from './item-actions';
import { resolveActiveView } from './active-view';
import { ItemBody } from './item-body';
import { ItemDialogs, type ItemDialogName } from './item-dialogs';
import { ItemHeader } from './item-header';
import { ItemPanels } from './item-panels';
import { InlineCommentCard } from '../../panel/inline-comment-card';
import { CommentsPane } from '../../panel/comments-pane';
import type { ItemProperties } from '@nix/web-collections/properties/use-item-properties';
import { bodyNoun, clockTime } from './lock-copy';
import { useItemViewActions } from './use-item-view-actions';
import { ItemViewSuggestions } from './item-view-suggestions';

const addableViews = STRUCTURED_RECIPES.filter(
  (recipe, index, all) =>
    all.findIndex((candidate) => candidate.viewKind === recipe.viewKind) === index,
);

interface OpenItemProps {
  readonly tree: ShellContext['tree'];
  readonly itemId: string;
  readonly title: string;

  /** The item's `type`: how its own body is drawn. Never gates what it may contain. */
  readonly bodyKind: string;
  readonly defaultToComments?: boolean;
  readonly renderContext?: ((details: ItemProperties) => ReactNode) | undefined;
  readonly canManageTemplates: boolean;
  readonly canApplyTemplates: boolean;
  readonly onOpen: (itemId: string) => void;

  /** Opens an item in another pane, for views set to open beside. */
  readonly onOpenBeside?: ((itemId: string) => void) | undefined;

  /** Opens an item as a pinned tab, for views set to open in a new tab. */
  readonly onOpenPinned?: ((itemId: string) => void) | undefined;

  /** Closes this pane, or absent when it is the only one and there is nothing to close to. */
  readonly onClose: (() => void) | undefined;

  /** Editing the title is a commitment to this document - it gets pinned, the way a double-click
   * from the tree does. */
  readonly onCommit: () => void;
  readonly onNavigateAway?: () => void;
}

export function OpenItem({
  tree,
  itemId,
  title,
  bodyKind,
  defaultToComments = false,
  renderContext,
  canManageTemplates,
  canApplyTemplates,
  onOpen,
  onOpenBeside,
  onOpenPinned,
  onClose,
  onCommit,
  onNavigateAway,
}: OpenItemProps): ReactNode {
  const visibility = useHiddenItems();
  const treeChildren = useHiddenItems('tree-children');
  const navigate = useNavigate();
  const kept = useIsKept(itemId);
  const toggleBookmark = useBookmarksStore((state) => state.toggle);
  const openChat = useOpenChat();
  const narrow = useNarrowViewport();
  // Zen draws the item and its sync state alone. Everything it removes below is not rendered
  // rather than hidden, and every removal is a sibling of the body in a fixed position, never a
  // wrapper around it: `null` keeps the slot, so the editor is neither remounted nor re-keyed.
  const zen = useZenActive();
  // Creation shares the tree cache with navigation. Loading children does not expand the
  // sidebar; only an explicit expansion there changes which descendants are visible.
  const createChild = useCallback(
    async (
      title: string,
      properties?: Record<string, unknown>,
      onCreated?: (createdId: string) => void,
    ): Promise<string | null> => {
      const { id, refusal } = await tree.create(itemId, title, 'note', properties);
      if (id !== null && refusal === null) onCreated?.(id);
      return refusal;
    },
    [itemId, tree],
  );

  const container = useContainer(itemId, createChild);
  // An item whose default view is a query is a smart list, which the rail's Queries section lists.
  const workspace = useOptionalWorkspace();
  useRememberSmartList(workspace?.workspaceId ?? null, itemId, title, container.views);
  const {
    hidden,
    entries: viewActions,
    add: addSuggestedView,
  } = useItemViewActions(itemId, workspace?.workspaceId);
  const { viewId, selectView } = useViewState();
  const boardComments = bodyKind === 'note' && defaultToComments;
  const showingComments =
    (boardComments && viewId === null) || (bodyKind === 'note' && viewId === COMMENTS_VIEW);
  const commentsTab = boardComments || showingComments;
  const storedViews = container.views;
  const { setDefaultViewKind } = tree;
  const defaultViewKind = storedViews?.views.find((view) => view.id === storedViews.default)?.kind;
  const viewsLoaded = storedViews !== null;
  useEffect(() => {
    if (viewsLoaded) setDefaultViewKind(itemId, defaultViewKind ?? null);
  }, [defaultViewKind, itemId, setDefaultViewKind, viewsLoaded]);
  const documentTabHidden =
    hidden.has(DOCUMENT_VIEW) ||
    (storedViews?.hideDocument === true &&
      storedViews.views.some((view) => !storedViews.unrenderable.includes(view.id)));
  const visibleViews = (storedViews?.views ?? []).filter((view) => !hidden.has(view.id));
  function fallbackView(excluding?: string): string {
    if (!documentTabHidden && excluding !== DOCUMENT_VIEW) return DOCUMENT_VIEW;
    return (
      visibleViews.find(
        (view) => view.id !== excluding && !storedViews?.unrenderable.includes(view.id),
      )?.id ?? (boardComments ? COMMENTS_VIEW : DOCUMENT_VIEW)
    );
  }
  const requested =
    viewId ?? (hidden.has(storedViews?.default ?? DOCUMENT_VIEW) ? fallbackView() : null);
  const overlayDetails = useOverlayDetails();
  // The settings open over the page - a dialog, or a drawer on touch screens - so each note starts
  // with them closed rather than reopening them on every visit.
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelPane, setPanelPane] = useState<Pane>('details');

  // The dialog is mounted only while it is open, so an export that was never started costs nothing
  // and a closed one keeps no half-chosen format from last time.
  const [dialog, setDialog] = useState<ItemDialogName | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [leadingHeading, setLeadingHeading] = useState<string | null>(null);
  const { getAccessToken } = useAuth();

  // Whether the body and views may be drawn. Core refuses a locked body, and the children every
  // view draws from, to a session that has not unlocked them - including when the lock is an
  // ancestor's. This is what lets the page say so, and close both when the unlock runs out, instead
  // of drawing an editor that cannot connect or a view over nothing.
  const lock = useItemLock(itemId);
  useForgetLockedBody(itemId, lock);
  const lockNoun = bodyNoun(bodyKind);
  const lockButtonRef = useRef<HTMLButtonElement>(null);

  // A dialog opened on an open body goes when the body closes - a relock or an expiry - rather
  // than reappearing, with its fields reset, the next time the body opens.
  if (dialog === 'lock' && !lock.open && lock.status !== 'loading') {
    setDialog(null);
  }

  // The prompt unmounts when the right password is given; focus goes to the lock control that now
  // stands for the open body, rather than to nothing.
  const { unlock } = lock;
  const { reload: reloadContainer } = container;
  const unlockAndFocus = useCallback(
    async (password: string): Promise<string | null> => {
      const refused = await unlock(password);
      if (refused === null) {
        // The children were withheld while the lock was closed; read them now it is open.
        void reloadContainer();
        requestAnimationFrame(() => {
          lockButtonRef.current?.focus();
        });
      }
      return refused;
    },
    [reloadContainer, unlock],
  );

  // A lock inherited from an ancestor is opened with that ancestor's password, so the prompt names
  // it. Null when the lock is this item's own.
  const lockHolderTitle =
    lock.lockItemId !== null && lock.lockItemId !== itemId
      ? (tree.find(lock.lockItemId)?.title ?? '')
      : null;
  const paneIndex = usePaneIndex();

  const togglePanel = useCallback((): void => {
    setPanelOpen((current) => !current);
  }, []);

  // The phone top row's details button; phones show one pane, so only the first answers.
  useEffect(() => {
    if (paneIndex !== 0) return;
    window.addEventListener(TOGGLE_ITEM_PANEL_EVENT, togglePanel);
    return () => {
      window.removeEventListener(TOGGLE_ITEM_PANEL_EVENT, togglePanel);
    };
  }, [paneIndex, togglePanel]);

  function openSitePane(): void {
    setPanelPane('site');
    if (!panelOpen) togglePanel();
    focusSitePaneHeading();
  }
  function openCommentsPane(): void {
    setPanelPane('comments');
    if (!panelOpen) togglePanel();
  }
  const sitesEnabled = useSitesVisible();
  const hasSite = useItemHasSite(itemId, sitesEnabled);

  const details = useItemProperties(itemId);

  // The marker the server puts on every daily note; the title is configurable and says nothing.
  const dailyMarker = details.item?.properties.$daily;
  const dailyDate = typeof dailyMarker === 'string' ? parseDailyNoteDate(dailyMarker) : null;

  const { views, unrenderable, storedDefault, active, activeId, showChildren, showingDocument } =
    useMemo(
      () => resolveActiveView(container.views, requested === COMMENTS_VIEW ? null : requested),
      [container.views, requested],
    );
  const selectedViewId = showingComments
    ? COMMENTS_VIEW
    : showingDocument
      ? DOCUMENT_VIEW
      : showChildren
        ? ''
        : activeId;
  const canManageViews = lock.open && workspace !== null && container.status === 'ready';
  const hiddenViews = [
    ...(documentTabHidden && (hidden.has(DOCUMENT_VIEW) || canManageViews)
      ? [{ id: DOCUMENT_VIEW, name: 'Document' }]
      : []),
    ...views.filter((view) => hidden.has(view.id)),
  ];

  // On a phone, a note's writing dock carries Details and the item actions itself (see
  // `MobileNoteToolbar`), so the section row under the title is only drawn for the bodies that have
  // no dock: canvases, sheets, files, and any view of the item's children.
  // On a phone the item's own controls - Details and the item actions - sit in exactly one bar that
  // is already on screen, rather than in a row of their own under the title. In order: the views
  // strip, when the item has views (it also carries Body, so it is the one place for all three);
  // otherwise the writing dock of a note, or the bar a canvas, sheet or file draws for itself. Only
  // a body that cannot be shown - locked, or failed to load - falls back to the row.
  const contextualView = renderContext === undefined || zen ? undefined : renderContext(details);
  const viewsHostControls =
    narrow && contextualView === undefined && (views.length > 0 || showingComments);
  const editorKind = bodyKind === 'canvas' || bodyKind === 'spreadsheet' || bodyKind === 'file';
  const noteDocked =
    narrow &&
    contextualView === undefined &&
    !viewsHostControls &&
    // Still loading counts: most notes open, and drawing the row only to remove it once the lock
    // answers would make it flicker. A note that turns out locked has no dock, so it gets the row.
    (lock.open || lock.status === 'loading') &&
    showingDocument &&
    !editorKind;
  const editorHostsControls =
    narrow &&
    contextualView === undefined &&
    !viewsHostControls &&
    lock.open &&
    showingDocument &&
    editorKind;
  const sectionRowShown = narrow && !viewsHostControls && !noteDocked && !editorHostsControls;

  const mobileItemControls = (
    <>
      <Button variant="ghost" aria-expanded={panelOpen} onClick={togglePanel}>
        Details
      </Button>
      <Button
        variant="icon"
        aria-label="Item actions"
        onClick={() => {
          setActionsOpen(true);
        }}
      >
        <Icon icon={MoreHorizontal} size="sm" />
      </Button>
    </>
  );

  const actionEntries = itemActionEntries({
    itemId,
    title,
    lockNoun,
    lock,
    workspace,
    visibility,
    treeChildren,
    navigate,
    openChat,
    onNavigateAway,
    onClose,
    sitesEnabled,
    hasSite,
    openSitePane,
    openCommentsPane:
      lock.open && showingDocument && !showingComments && !editorKind
        ? openCommentsPane
        : undefined,
    openDocument:
      lock.open && documentTabHidden && selectedViewId !== DOCUMENT_VIEW
        ? () => {
            selectView(DOCUMENT_VIEW);
          }
        : undefined,
    canApplyTemplates,
    canManageTemplates,
    historyOpen,
    setHistoryOpen,
    openDialog: setDialog,
  });

  const zenAvailable = lock.open;
  const bookmarkEntry: MenuEntry = {
    kind: 'action',
    label: kept ? 'Remove bookmark' : 'Bookmark',
    icon: Star,
    onSelect: () => {
      void toggleBookmark(itemId);
    },
  };
  // Two controls beside the title: the item's settings and "...". Bookmarking lives in the menu.
  const desktopControls = (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        variant="icon"
        aria-label="Settings"
        title="Item settings"
        aria-expanded={panelOpen}
        onClick={togglePanel}
      >
        <Icon icon={Settings2} size="sm" />
      </Button>
      <Menu
        label="Item actions"
        items={
          zenAvailable
            ? [
                bookmarkEntry,
                ...actionEntries,
                // The phone's sheet carries its own Zen button, so the entry is added here only.
                {
                  kind: 'action',
                  label: 'Enter Zen mode',
                  icon: Maximize2,
                  onSelect: toggleZenMode,
                },
              ]
            : [bookmarkEntry, ...actionEntries]
        }
      >
        {(trigger) => (
          <Button
            {...trigger}
            ref={(node) => {
              trigger.ref.current = node;
              lockButtonRef.current = node;
            }}
            variant="icon"
            aria-label="Item actions"
            title="Item actions"
          >
            <Icon icon={MoreHorizontal} size="sm" />
          </Button>
        )}
      </Menu>
    </div>
  );

  // Phone actions share the same commands, in the writing dock's existing sheet.
  const itemActions = (
    <div className="grid grid-cols-2 gap-2">
      <BookmarkButton compact itemId={itemId} title={title} />
      {actionEntries.map((entry) => (
        <Button key={entry.key} variant="ghost" className="justify-start" onClick={entry.onSelect}>
          {entry.icon === undefined ? null : <Icon icon={entry.icon} size="sm" />}
          {entry.label}
        </Button>
      ))}
      {zenAvailable ? (
        <Button variant="ghost" aria-label="Enter Zen mode" onClick={toggleZenMode}>
          <Icon icon={Maximize2} size="sm" />
          Zen
        </Button>
      ) : null}
      <Button variant="ghost" aria-expanded={panelOpen} onClick={togglePanel}>
        <Icon icon={Settings2} size="sm" />
        Settings
      </Button>
    </div>
  );

  const addView = canManageViews ? (
    <Menu
      label="Add view"
      items={[
        {
          label: 'Suggest views',
          icon: Sparkles,
          onSelect: () => {
            setSuggestionsOpen(true);
          },
        },
        { kind: 'separator' },
        ...addableViews.map((recipe) => ({
          label: recipe.label,
          onSelect: () => {
            onNavigateAway?.();
            void navigate(`/items/${itemId}/views/new/${recipe.id}`);
          },
        })),
      ]}
    >
      {(trigger) => (
        <Button {...trigger} variant="secondary" className="shrink-0 whitespace-nowrap">
          <Icon icon={Plus} size="sm" /> Add view
        </Button>
      )}
    </Menu>
  ) : undefined;

  // The prose editor, for notes and every kind this build has not heard of.
  const proseEditor = (
    <NoteEditor
      itemId={itemId}
      onLeadingHeadingChange={setLeadingHeading}
      cacheBody={!lock.locked}
      hideToolbar={zen}
      mobileActions={noteDocked && !zen ? itemActions : undefined}
      mobileDetails={noteDocked && !zen ? { open: panelOpen, onToggle: togglePanel } : undefined}
      // From the tree the page already holds: no fetch, only a ranking hint.
      parentId={tree.find(itemId)?.parentId}
    />
  );

  return (
    <>
      <div className="flex min-w-0 shrink-0">
        <ItemHeader
          tree={tree}
          itemId={itemId}
          title={title}
          bodyKind={bodyKind}
          onNavigate={onOpen}
          onCommit={onCommit}
          reading={showingDocument && !showingComments && !editorKind}
          titleInBody={
            lock.open &&
            showingDocument &&
            !showingComments &&
            !editorKind &&
            contextualView === undefined &&
            leadingHeading !== null &&
            leadingHeading !== '' &&
            leadingHeading === title.trim()
          }
          trailing={narrow || zen ? undefined : desktopControls}
        />
      </div>

      {zen ? null : sectionRowShown ? (
        <nav
          aria-label="Item sections"
          className="flex shrink-0 items-center justify-end gap-1 border-b border-divider px-3 pb-2"
        >
          {/* Body only when it is a way back: from a listing of the item's children. With views,
              the views strip carries it; on the body itself it would select what is showing. */}
          {showingDocument || contextualView !== undefined || documentTabHidden ? null : (
            <Button
              variant="ghost"
              className="mr-auto"
              onClick={() => {
                selectView(DOCUMENT_VIEW);
              }}
            >
              Body
            </Button>
          )}
          {mobileItemControls}
        </nav>
      ) : null}
      {(views.length > 0 || commentsTab || addView !== undefined) &&
      !zen &&
      contextualView === undefined ? (
        <ViewSwitcher
          views={visibleViews}
          unrenderable={unrenderable}
          activeViewId={selectedViewId}
          comments={commentsTab}
          addView={addView}
          viewActions={
            lock.open
              ? (id) =>
                  viewActions({
                    id,
                    view: views.find((view) => view.id === id),
                    stored: storedViews,
                    canHide:
                      boardComments ||
                      visibleViews.some((view) => view.id !== id) ||
                      (id !== DOCUMENT_VIEW && !documentTabHidden),
                    canWrite: canManageViews,
                    leave: () => {
                      if (id === selectedViewId) selectView(fallbackView(id));
                    },
                    restoreViews: hiddenViews,
                  })
              : undefined
          }
          trailing={viewsHostControls ? mobileItemControls : undefined}
          tools={
            // An empty fragment, not undefined: a defined slot keeps the row's markup (and so the
            // tabs) from being rebuilt every time the document is chosen.
            showingDocument || showingComments ? (
              <></>
            ) : (
              <ContainerViewTools
                container={container}
                view={showChildren ? null : active}
                placement="row"
              />
            )
          }
          documentLabel={narrow ? 'Body' : 'Document'}
          documentHidden={documentTabHidden}
          defaultViewId={boardComments ? COMMENTS_VIEW : storedDefault}
          onSelect={(chosen) => {
            selectView(chosen);
          }}
        />
      ) : null}
      {suggestionsOpen && lock.open && workspace !== null ? (
        <ItemViewSuggestions
          key={itemId}
          itemId={itemId}
          workspaceId={workspace.workspaceId}
          container={container}
          onApply={async (view) => {
            const saved = await addSuggestedView(view);
            if (saved) await container.reload();
            return saved;
          }}
          onClose={() => {
            setSuggestionsOpen(false);
          }}
          onSaved={(view) => {
            setSuggestionsOpen(false);
            selectView(view.id);
          }}
        />
      ) : null}
      {actionsOpen ? (
        <Dialog
          open
          swipeToClose
          title="Item actions"
          onClose={() => {
            setActionsOpen(false);
          }}
        >
          <div
            onClickCapture={(event) => {
              if (event.target instanceof Element && event.target.closest('button'))
                setActionsOpen(false);
            }}
          >
            {itemActions}
          </div>
        </Dialog>
      ) : null}

      {lock.closingSoon && lock.unlockedUntil !== null && !zen ? (
        <Text variant="note" role="status" tone="muted" className="px-5 py-1 sm:px-8">
          Locks again at {clockTime(lock.unlockedUntil)}
        </Text>
      ) : null}

      {/* A fixed-height strip between the item's own controls and the body, so the body keeps the
          one scroller it always had. Absent for every note that is not a daily note. */}
      {dailyDate === null || zen ? null : <DailyNoteBar date={dailyDate} itemId={itemId} />}

      <InlineCommentCard itemId={itemId} />

      <div className={`flex flex-1 ${paneClip}`}>
        <ItemBody
          itemId={itemId}
          title={title}
          bodyKind={bodyKind}
          lockNoun={lockNoun}
          lock={lock}
          lockHolderTitle={lockHolderTitle}
          onUnlock={unlockAndFocus}
          showingDocument={showingDocument}
          showChildren={showChildren}
          active={active}
          views={views}
          container={container}
          paneIndex={paneIndex}
          proseEditor={proseEditor}
          contextView={
            contextualView ??
            (showingComments ? (
              <section aria-label="Comments" className={paneScroller}>
                <div className="mx-auto w-full max-w-3xl px-4 py-4 sm:px-8">
                  <CommentsPane key={itemId} itemId={itemId} conversation />
                </div>
              </section>
            ) : undefined)
          }
          editorHostsControls={editorHostsControls}
          mobileItemControls={mobileItemControls}
          onOpen={onOpen}
          onOpenBeside={onOpenBeside}
          onOpenPinned={onOpenPinned}
          toolsInRow={views.length > 0 && !zen}
        />

        {zen ? null : (
          <ItemPanels
            itemId={itemId}
            container={container}
            details={details}
            panelOpen={panelOpen}
            overlayDetails={overlayDetails}
            panelPane={panelPane}
            onPanelPaneChange={setPanelPane}
            onTogglePanel={togglePanel}
            historyOpen={historyOpen && lock.open}
            onCloseHistory={() => {
              setHistoryOpen(false);
            }}
          />
        )}
      </div>

      <ItemDialogs
        open={dialog}
        onClose={() => {
          setDialog(null);
        }}
        tree={tree}
        itemId={itemId}
        title={title}
        lockNoun={lockNoun}
        lock={lock}
        getAccessToken={getAccessToken}
      />
    </>
  );
}
