import { Dialog } from '@nix/ui';
import { useEffect, type ReactNode } from 'react';

import { SidebarDrawer } from '@nix/web-foundation/layout/sidebar-drawer';
import { useEdgeSwipeOpen } from '@nix/web-foundation/layout/use-edge-swipe';
import { useBackDismiss } from '@nix/web-foundation/layout/use-back-dismiss';
import { useMediaQuery } from '@nix/web-foundation/layout/viewport';
import { DocumentHistory } from '../../history/document-history';
import { historyPanelWidth } from '@nix/web-foundation/layout/regions';
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

/** The settings panel and the revision history, beside the body on a wide window and over it on a narrow one. */
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
  const phone = !useMediaQuery('(min-width: 640px)');
  // Swipe in from the right edge opens the panel; closing is the drawer's own drag, scrim or Escape.
  useEdgeSwipeOpen('right', phone && !panelOpen, togglePanel);
  // Always mounted, like the shell's own: a hook that mounts with the drawer would race its own cleanup.
  useBackDismiss(phone && panelOpen, togglePanel);
  return (
    <>
      {panelOpen && phone ? (
        <PhonePanelDrawer onClose={togglePanel}>
          <ItemPanel
            container={container}
            details={details}
            onClose={togglePanel}
            drawer
            pane={panelPane}
            onPaneChange={setPanelPane}
          />
        </PhonePanelDrawer>
      ) : panelOpen ? (
        overlayDetails ? (
          <Dialog
            open
            title="Item details"
            onClose={togglePanel}
            presentation="workspace"
            className="sm:max-w-xl"
          >
            <ItemPanel
              container={container}
              details={details}
              onClose={togglePanel}
              overlay
              pane={panelPane}
              onPaneChange={setPanelPane}
            />
          </Dialog>
        ) : (
          <ItemPanel
            container={container}
            details={details}
            onClose={togglePanel}
            pane={panelPane}
            onPaneChange={setPanelPane}
          />
        )
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
