import { MobileWorkspaceBrowser } from '../items/mobile-workspace-browser';
import { focusPane } from '@nix/web-platform/panes/pane-params';
import type { OpenItemControl } from '../tabs/use-open-item';
import { SidebarDivider } from '@nix/web-foundation/layout/sidebar-divider';
import { SidebarDrawer } from '@nix/web-foundation/layout/sidebar-drawer';
import type { Sidebar } from '@nix/web-foundation/layout/use-sidebar';
import { WorkspaceSidebar } from '../items/workspace-sidebar';
import type { TreeItem, WorkspaceTree } from '@nix/web-collections/items/use-workspace-tree';
import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { TITLE_ROW_LEAD_ID } from '../tabs/title-row-slot';

export interface ShellSidebarProps {
  readonly narrow: boolean;
  readonly sidebar: Sidebar;
  readonly tree: WorkspaceTree;
  readonly selectedId: string | null;
  readonly openItem: Pick<
    OpenItemControl,
    'openPreview' | 'openPinned' | 'openBeside' | 'canOpenBeside' | 'besideRefusal'
  >;
  readonly onDeleteItem: (item: TreeItem) => void;
  readonly onAdd: () => void;
  readonly treeRegionRef: RefObject<HTMLDivElement | null>;
  readonly sidebarToggleRef: RefObject<HTMLButtonElement | null>;
  readonly searchRef: RefObject<HTMLInputElement | null>;
}

/**
 * Presents the workspace tree in its two shell-owned arrangements: fixed beside the pane or
 * temporarily in a narrow-screen drawer.
 */
export function ShellSidebar({
  narrow,
  sidebar,
  tree,
  selectedId,
  openItem,
  onDeleteItem,
  onAdd,
  treeRegionRef,
  sidebarToggleRef,
  searchRef,
}: ShellSidebarProps): ReactNode {
  const [browseParent, setBrowseParent] = useState<string | null>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);

  function closeDrawerAfter<Args extends readonly string[]>(
    action: (...args: Args) => void,
  ): (...args: Args) => void {
    return (...args: Args) => {
      action(...args);
      if (narrow) {
        sidebar.toggle();
        // `focusPane` defers until the pane has rendered and the drawer has removed `inert` from
        // `<main>`, so the focus call is not silently ignored.
        focusPane(0);
      }
    };
  }

  function closeDrawer(): void {
    sidebar.toggle();
    sidebarToggleRef.current?.focus();
  }

  const workspaceTree = (
    <WorkspaceSidebar
      tree={tree}
      selectedId={selectedId}
      onSelect={openItem.openPreview}
      onOpenBeside={openItem.openBeside}
      onOpenPinned={openItem.openPinned}
      canOpenBeside={openItem.canOpenBeside}
      besideRefusal={openItem.besideRefusal}
      onDeleteItem={onDeleteItem}
      onAdd={onAdd}
      treeRegionRef={treeRegionRef}
      searchRef={searchRef}
    />
  );

  return (
    <>
      {!sidebar.visible ? null : narrow ? (
        <SidebarDrawer fill onClose={closeDrawer}>
          <MobileWorkspaceBrowser
            tree={tree}
            parentId={browseParent}
            onParent={setBrowseParent}
            onOpen={closeDrawerAfter(openItem.openPreview)}
            onClose={closeDrawer}
          />
        </SidebarDrawer>
      ) : (
        <>
          <div
            ref={sidebarRef}
            style={{ width: `${String(sidebar.width)}px` }} // design-token-exempt: runtime drag width.
            className="flex shrink-0 overflow-hidden"
          >
            {workspaceTree}
          </div>

          <SidebarDivider
            width={sidebar.width}
            onPreview={(width) => {
              sidebarRef.current?.style.setProperty('width', `${String(width)}px`);
              // The title row's leading controls follow, so the tabs keep starting over the page.
              document
                .getElementById(TITLE_ROW_LEAD_ID)
                ?.style.setProperty('width', `${String(width)}px`);
            }}
            onCommit={sidebar.resize}
          />
        </>
      )}
    </>
  );
}
