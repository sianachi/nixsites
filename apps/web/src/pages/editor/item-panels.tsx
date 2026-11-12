import { Button, Dialog, Icon, Text } from '@nix/ui';
import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

import { SidebarDrawer } from '@nix/web-foundation/layout/sidebar-drawer';
import { useEdgeSwipeOpen } from '@nix/web-foundation/layout/use-edge-swipe';
import { useBackDismiss } from '@nix/web-foundation/layout/use-back-dismiss';
import { useLayoutKind, useNarrowViewport } from '@nix/web-foundation/layout/viewport';
import { DocumentHistory } from '../../history/document-history';
import { historyPanelWidth, settingsPanelWidth } from '@nix/web-foundation/layout/regions';
import { ItemPanel, type Pane } from '../../panel/item-panel';
import type { useItemProperties } from '@nix/web-collections/properties/use-item-properties';
import type { useContainer } from '@nix/web-collections/core/use-container';

interface ItemPanelsProps {
  readonly itemId: string;
  readonly container: ReturnType<typeof useContainer>;
  readonly details: ReturnType<typeof useItemProperties>;
  readonly panelOpen: boolean;
  readonly overlayDetails: boolean;
  readonly panelPane: Pane;
  readonly onPanelPaneChange: (pane: Pane) => void;
  readonly onTogglePanel: () => void;
  readonly historyOpen: boolean;
  readonly onCloseHistory: () => void;
}

/**
 * Contextual panels sit beside a wide note and open over a compact or split note.
 */
export function ItemPanels({
  itemId,
  container,
  details,
  panelOpen,
  overlayDetails,
  panelPane,
  onPanelPaneChange: setPanelPane,
  onTogglePanel: togglePanel,
  historyOpen,
  onCloseHistory,
}: ItemPanelsProps): ReactNode {
  // A landscape tablet's details slide over the page like the phone's drawer, not a centred dialog.
  const slideOver = useLayoutKind() === 'tablet-landscape';
  const phone = useNarrowViewport() || slideOver;
  // Swipe in from the right edge opens the panel; closing is the drawer's own drag, scrim or Escape.
  useEdgeSwipeOpen('right', phone && !panelOpen, togglePanel);
  // Always mounted, like the shell's own: a hook that mounts with the drawer would race its own cleanup.
  useBackDismiss(phone && panelOpen, togglePanel);
  const itemPanel = panelOpen ? (
    <ItemPanel
      container={container}
      details={details}
      onClose={togglePanel}
      drawer={phone}
      pane={panelPane}
      onPaneChange={setPanelPane}
    />
  ) : null;
  return (
    <>
      {panelOpen && phone ? (
        <PhonePanelDrawer onClose={togglePanel}>{itemPanel}</PhonePanelDrawer>
      ) : panelOpen && overlayDetails ? (
        <Dialog
          open
          title="Item details"
          onClose={togglePanel}
          presentation="workspace"
          className="sm:max-w-xl"
        >
          {itemPanel}
        </Dialog>
      ) : panelOpen ? (
        <InlineItemPanel onClose={togglePanel}>{itemPanel}</InlineItemPanel>
      ) : null}

      {/* The document's revisions, beside it on a wide window and over it on a narrow one - the
          same two shapes the settings panel takes, for the same reasons. */}
      {historyOpen ? (
        overlayDetails ? (
          <Dialog
            open
            title="History"
            onClose={() => {
              onCloseHistory();
            }}
            presentation="workspace"
            className="sm:max-w-2xl"
          >
            <DocumentHistory
              itemId={itemId}
              onClose={() => {
                onCloseHistory();
              }}
            />
          </Dialog>
        ) : (
          <div
            className={`flex shrink-0 flex-col overflow-hidden border-l border-divider ${historyPanelWidth}`}
          >
            <DocumentHistory
              itemId={itemId}
              onClose={() => {
                onCloseHistory();
              }}
            />
          </div>
        )
      ) : null}
    </>
  );
}

function InlineItemPanel({
  children,
  onClose,
}: {
  readonly children: ReactNode;
  readonly onClose: () => void;
}): ReactNode {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement;
    const closeButton = closeRef.current;
    closeButton?.focus({ preventScroll: true });
    return () => {
      if (
        opener instanceof HTMLElement &&
        opener.isConnected &&
        (document.activeElement === document.body || document.activeElement === closeButton)
      ) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);
  return (
    <div
      className={`flex min-h-0 shrink-0 flex-col overflow-hidden border-l border-divider bg-surface ${settingsPanelWidth}`}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-divider px-3 py-2">
        <Text as="h2" variant="h6">
          Item details
        </Text>
        <Button ref={closeRef} variant="icon" aria-label="Close item details" onClick={onClose}>
          <Icon icon={X} size="sm" />
        </Button>
      </div>
      {children}
    </div>
  );
}

function PhonePanelDrawer({
  onClose,
  children,
}: {
  readonly onClose: () => void;
  readonly children: ReactNode;
}): ReactNode {
  // The drawer is not a native dialog, so hand focus back to what opened it ourselves.
  useEffect(() => {
    const opener = document.activeElement;
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  return (
    <SidebarDrawer side="right" fixed onClose={onClose}>
      {children}
    </SidebarDrawer>
  );
}
