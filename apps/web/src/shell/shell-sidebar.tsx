import { MobileWorkspaceBrowser } from '../items/mobile-workspace-browser';
import { focusPane } from '@nix/web-platform/panes/pane-params';
import type { OpenItemControl } from '../tabs/use-open-item';
import type { StructuredRecipeId } from '@nix/web-views/wizard/structured-recipes';
import type { TemplateLibraryStatus } from '@nix/web-templates/templates/use-templates';
import type { TemplateSummary } from '@nix/web-templates/templates/template-api';
import { SidebarDivider } from '@nix/web-foundation/layout/sidebar-divider';
import { SidebarDrawer } from '@nix/web-foundation/layout/sidebar-drawer';
import type { Sidebar } from '@nix/web-foundation/layout/use-sidebar';
import { WorkspaceSidebar } from '../items/workspace-sidebar';
import type { TreeItem, WorkspaceTree } from '@nix/web-collections/items/use-workspace-tree';
import { useRef, useState, type ReactNode, type RefObject } from 'react';

export interface ShellSidebarProps {
  readonly narrow: boolean;
  readonly mobileDestinations: ReactNode;
  readonly sidebar: Sidebar;
  readonly tree: WorkspaceTree;
  readonly selectedId: string | null;
  readonly openItem: Pick<
    OpenItemControl,
    'openPreview' | 'openPinned' | 'openBeside' | 'canOpenBeside' | 'besideRefusal'
  >;
  readonly onDeleteItem: (item: TreeItem) => void;
  readonly onStartStructured: (parentId: string | null, recipe: StructuredRecipeId) => void;
  readonly templates: readonly TemplateSummary[];
  readonly templateStatus: TemplateLibraryStatus;
  readonly onStartTemplate: (parentId: string | null, templateId: string) => void;
  readonly onBrowseTemplates: (parentId: string | null) => void;
  readonly treeRegionRef: RefObject<HTMLDivElement | null>;
  readonly sidebarToggleRef: RefObject<HTMLButtonElement | null>;
}

/**
 * Presents the workspace tree in its two shell-owned arrangements: fixed beside the pane or
 * temporarily in a narrow-screen drawer.
 */
export function ShellSidebar({
  narrow,
  mobileDestinations,
  sidebar,
  tree,
  selectedId,
  openItem,
  onDeleteItem,
  onStartStructured,
  templates,
  templateStatus,
  onStartTemplate,
  onBrowseTemplates,
  treeRegionRef,
  sidebarToggleRef,
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
      onStartStructured={onStartStructured}
      templates={templates}
      templateStatus={templateStatus}
      onStartTemplate={onStartTemplate}
      onBrowseTemplates={onBrowseTemplates}
      treeRegionRef={treeRegionRef}
    />
  );

  return (
    <>
      {!sidebar.visible ? null : narrow ? (
        <SidebarDrawer onClose={closeDrawer}>
          {/* One browser owns the phone's width. Occasional item and destination actions are
              disclosed from it instead of competing in a second navigation column. */}
          <MobileWorkspaceBrowser
            tree={tree}
            parentId={browseParent}
            onParent={setBrowseParent}
            onOpen={closeDrawerAfter(openItem.openPreview)}
            onClose={closeDrawer}
            destinations={mobileDestinations}
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
            }}
            onCommit={sidebar.resize}
          />
        </>
      )}
    </>
  );
}
