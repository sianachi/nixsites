import { Button, Dialog, Icon, Menu, Text } from '@nix/ui';
import { MoreHorizontal, Settings2, Maximize2 } from 'lucide-react';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { useAuth } from '@nix/web-platform/auth/auth-provider';
import { BookmarkButton } from '../../bookmarks/bookmark-button';
import { DailyNoteBar } from '../../daily-notes/daily-note-bar';
import { parseDailyNoteDate } from '../../daily-notes/daily-note';
import { NoteEditor } from '../../editor/note-editor';
import { useHiddenItems } from '../../items/use-hidden-items';
import {
  historyPanelWidth,
  paneClip,
  settingsPanelWidth,
} from '@nix/web-foundation/layout/regions';
import { useNarrowViewport, useOverlayDetails } from '@nix/web-foundation/layout/viewport';
import { useForgetLockedBody } from '../../locks/use-forget-locked-body';
import { useItemLock } from '../../locks/use-item-lock';
import { browserStorage } from '@nix/web-foundation/lib/browser-storage';
import { toggleZenMode, useZenActive } from '@nix/web-foundation/lib/zen-mode';
import { usePaneIndex } from '@nix/web-platform/panes/pane-context';
import { readPanelOpen, storePanelOpen } from '../../panel/panel-state';
import type { Pane } from '../../panel/item-panel';
import { useItemProperties } from '../../properties/use-item-properties';
import { useSitesVisible } from '../../settings/publishing/publishing-preference';
import type { ShellContext } from '../../shell/shell-context';
import { focusSitePaneHeading } from '../../sites/site-pane';
import { useItemHasSite } from '../../sites/use-item-site';
import { useOpenChat } from '../../tabs/use-open-chat';
import { DOCUMENT_VIEW, type View } from '../../views/core/container-model';
import { ContainerViewTools } from '../../views/core/container-view';
import { useContainer } from '../../views/core/use-container';
import { useViewState } from '../../views/core/view-state';
import { ViewSwitcher } from '../../views/core/view-switcher';
import { useRememberSmartList } from '../../views/query/known-smart-lists';
import { useOptionalWorkspace } from '../../workspaces/workspace-context';
import { itemActionEntries } from './item-actions';
import { ItemBody } from './item-body';
import { ItemDialogs, type ItemDialogName } from './item-dialogs';
import { ItemHeader } from './item-header';
import { ItemPanels } from './item-panels';
import { bodyNoun, clockTime } from './lock-copy';

interface OpenItemProps {
  readonly tree: ShellContext['tree'];
  readonly itemId: string;
  readonly title: string;

  /** The item's `type`: how its own body is drawn. Never gates what it may contain. */
  readonly bodyKind: string;
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
  const openChat = useOpenChat();
  const narrow = useNarrowViewport();
  // Zen draws the item and its sync state alone. Everything it removes below is not rendered
  // rather than hidden, and every removal is a sibling of the body in a fixed position, never a
  // wrapper around it: `null` keeps the slot, so the editor is neither remounted nor re-keyed.
  const zen = useZenActive();
  // Creation shares the tree cache with navigation. Loading children does not expand the
  // sidebar; only an explicit expansion there changes which descendants are visible.
  const createChild = useCallback(
    async (title: string, properties?: Record<string, unknown>): Promise<string | null> => {
      const { refusal } = await tree.create(itemId, title, 'note', properties);
      return refusal;
    },
    [itemId, tree],
  );

  const container = useContainer(itemId, createChild);
  // An item whose default view is a query is a smart list, which the rail's Queries section lists.
  const workspace = useOptionalWorkspace();
  useRememberSmartList(workspace?.workspaceId ?? null, itemId, title, container.views);
  const { viewId, selectView } = useViewState();
  // Remembered the way the tree's own collapse is, and for the same reason: somebody who closed it
  // wanted the width back, and finding it open again would make the control feel like it had not
  // worked.
  const overlayDetails = useOverlayDetails();
  const [inlinePanelOpen, setInlinePanelOpen] = useState(() => readPanelOpen(browserStorage()));
  const [overlayPanelOpen, setOverlayPanelOpen] = useState(false);
  const panelOpen = overlayDetails ? overlayPanelOpen : inlinePanelOpen;
  const [panelPane, setPanelPane] = useState<Pane>('details');

  // The dialog is mounted only while it is open, so an export that was never started costs nothing
  // and a closed one keeps no half-chosen format from last time.
  const [dialog, setDialog] = useState<ItemDialogName | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
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

  function togglePanel(): void {
    if (overlayDetails) {
      setOverlayPanelOpen((current) => !current);
      return;
    }
    setInlinePanelOpen((current) => {
      storePanelOpen(browserStorage(), !current);
      return !current;
    });
  }

  function openSitePane(): void {
    setPanelPane('site');
    if (!panelOpen) togglePanel();
    focusSitePaneHeading();
  }
  const sitesEnabled = useSitesVisible();
  const hasSite = useItemHasSite(itemId, sitesEnabled);

  const details = useItemProperties(itemId);

  // The marker the server puts on every daily note; the title is configurable and says nothing.
  const dailyMarker = details.item?.properties.$daily;
  const dailyDate = typeof dailyMarker === 'string' ? parseDailyNoteDate(dailyMarker) : null;

  const views = useMemo(() => container.views?.views ?? [], [container.views]);
  const unrenderable = container.views?.unrenderable ?? [];

  // Whether the Document tab is left out. An item must never open blank, so the flag is honoured
  // only while there is a view to show instead; if every view is broken the document comes back
  // rather than leaving a pane with nothing but explanations of what went wrong.
  const documentHidden =
    container.views?.hideDocument === true && views.some((view) => !unrenderable.includes(view.id));

  // What the item says opens, unless the address says otherwise. The URL wins because it is the
  // more specific statement - somebody chose it, possibly in a link they were handed - and the
  // stored default is the starting point rather than the authority.
  const storedDefault = container.views?.default ?? DOCUMENT_VIEW;
  const requestedId = viewId ?? storedDefault;

  // While the document is hidden it can never be what is showing, whether it was asked for by the
  // address, by a stored default that should not say it, or by a view id this item does not have.
  // Core already resolves the default to the first view; this keeps the page consistent with that
  // rather than being a second opinion about it.
  const active = useMemo<View | null>(() => {
    const requested = views.find((view) => view.id === requestedId) ?? null;
    if (requested !== null || !documentHidden || requestedId === '__children__') {
      return requested;
    }
    return views[0] ?? null;
  }, [documentHidden, requestedId, views]);
  const activeId = active?.id ?? requestedId;

  // The body, when nothing else was chosen or when what was chosen is not a view this item has.
  // Existing shared links to the old children shortcut still open their list.
  const showChildren = activeId === '__children__';
  const showingDocument = active === null && !showChildren;

  // On a phone, a note's writing dock carries Details and the item actions itself (see
  // `MobileNoteToolbar`), so the section row under the title is only drawn for the bodies that have
  // no dock: canvases, sheets, files, and any view of the item's children.
  // On a phone the item's own controls - Details and the item actions - sit in exactly one bar that
  // is already on screen, rather than in a row of their own under the title. In order: the views
  // strip, when the item has views (it also carries Body, so it is the one place for all three);
  // otherwise the writing dock of a note, or the bar a canvas, sheet or file draws for itself. Only
  // a body that cannot be shown - locked, or failed to load - falls back to the row.
  const viewsHostControls = narrow && views.length > 0;
  const editorKind = bodyKind === 'canvas' || bodyKind === 'spreadsheet' || bodyKind === 'file';
  const noteDocked =
    narrow &&
    !viewsHostControls &&
    // Still loading counts: most notes open, and drawing the row only to remove it once the lock
    // answers would make it flicker. A note that turns out locked has no dock, so it gets the row.
    (lock.open || lock.status === 'loading') &&
    showingDocument &&
    !editorKind;
  const editorHostsControls =
    narrow && !viewsHostControls && lock.open && showingDocument && editorKind;
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
    canApplyTemplates,
    canManageTemplates,
    historyOpen,
    setHistoryOpen,
    openDialog: setDialog,
  });

  const zenAvailable = lock.open;
  const desktopControls = (
    <div className="flex shrink-0 items-center gap-1">
      <BookmarkButton compact itemId={itemId} title={title} />
      <Button
        variant="icon"
        aria-label="Settings"
        title="Item settings"
        aria-expanded={panelOpen}
        onClick={togglePanel}
      >
        <Icon icon={Settings2} size="sm" />
      </Button>
      <Menu label="Item actions" items={actionEntries}>
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

  // The prose editor, for notes and every kind this build has not heard of.
  const proseEditor = (
    <NoteEditor
      itemId={itemId}
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
          reading={showingDocument && !editorKind}
          trailing={narrow || zen ? undefined : desktopControls}
        />
        {panelOpen && !overlayDetails && !zen ? (
          <div aria-hidden="true" className={`shrink-0 ${settingsPanelWidth}`} />
        ) : null}
        {historyOpen && lock.open && !overlayDetails && !zen ? (
          <div aria-hidden="true" className={`shrink-0 ${historyPanelWidth}`} />
        ) : null}
      </div>

      {zen ? null : sectionRowShown ? (
        <nav
          aria-label="Item sections"
          className="flex shrink-0 items-center justify-end gap-1 border-b border-divider px-3 pb-2"
        >
          {/* Body only when it is a way back: from a listing of the item's children. With views,
              the views strip carries it; on the body itself it would select what is showing. */}
          {showingDocument || documentHidden ? null : (
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
      {views.length > 0 && !zen ? (
        <ViewSwitcher
          views={views}
          unrenderable={unrenderable}
          activeViewId={showingDocument ? DOCUMENT_VIEW : showChildren ? '' : activeId}
          trailing={narrow ? mobileItemControls : undefined}
          tools={
            // An empty fragment, not undefined: a defined slot keeps the row's markup (and so the
            // tabs) from being rebuilt every time the document is chosen.
            showingDocument ? (
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
          documentHidden={documentHidden}
          defaultViewId={storedDefault}
          onSelect={(chosen) => {
            selectView(chosen);
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
