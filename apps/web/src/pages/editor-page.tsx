import { Text } from '@nix/ui';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useOutletContext } from 'react-router';

import { announce } from '../a11y/announcer';
import { paneColumn } from '../layout/regions';
import { useZenActive } from '../lib/zen-mode';
import { PaneGroup } from '../panes/pane-group';
import { focusPane, paneElementId } from '../panes/pane-params';
import { PaneSplitControl } from '../panes/pane-split-control';
import { usePanes } from '../panes/pane-state';
import { usePaneCycling } from '../panes/use-pane-cycling';
import type { ShellContext } from '../shell/shell-context';
import type { TabTransferPayload } from '../tabs/tab-transfer';
import { useTabStore } from '../lib/tab-store';
import { useTabTransfer } from '../tabs/use-tab-transfer';
import { useTemplateLibrary } from '../templates/template-library-context';
import { PaneContents } from './editor/pane-contents';
import { Homebase } from './homebase';

// The item dialog draws an item too and still imports `OpenItem` from here.
export { OpenItem } from './editor/open-item';

/**
 * One item, open.
 *
 * **There is one kind of item, and this is its one screen.** It used to fork: a folder opened into
 * its views and could not hold a document, a note opened into an editor and could not hold
 * anything. That split was never in the schema - every row has always had a parent, a property
 * schema and a views column - so it was the interface refusing what the data allowed.
 *
 * What is left is two axes, and keeping them distinct is the thing to preserve here:
 *
 * - the item's **body**, which is its own content, and
 * - its **views**, which are ways of looking at its children.
 *
 * Only one is on screen at a time, so one switcher chooses, and the item remembers the choice. An
 * item nobody has configured a view on shows its body and no chrome whatsoever, which is every
 * plain note - the switcher returns nothing rather than offering a single "Document" tab.
 *
 * The tree is not here. It belongs to the shell, because it is how you move around the product
 * rather than part of this screen.
 */
export function EditorPage(): ReactNode {
  const { tree, openImport } = useOutletContext<ShellContext>();
  const templateLibrary = useTemplateLibrary();
  const { panes, split, sizes, requested, closePane, setSplit, setSizes } = usePanes();
  const paneClosed = useTabStore((state) => state.paneClosed);
  const [draggedTab, setDraggedTab] = useState<TabTransferPayload | null>(null);

  const zen = useZenActive();

  // Which pane Zen keeps: the one that last held focus, which is the one the reader pressed Zen
  // in, or pane zero. Tracked here rather than asked of the DOM at the moment of entry because the
  // button that enters it is unmounted by entering it.
  const [focusedPane, setFocusedPane] = useState(0);
  const zenPane = panes.find((pane) => pane.index === focusedPane) ?? panes[0];
  const shownPanes = zen && zenPane !== undefined ? [zenPane] : panes;

  // The control that was pressed to enter or leave Zen is gone once the layout changes, which
  // would drop focus on the document body. Put it on the pane instead - but only when it did fall
  // that far, so a shortcut pressed from inside the editor leaves the caret exactly where it was.
  const zenWas = useRef(zen);
  useEffect(() => {
    if (zenWas.current === zen) return;
    zenWas.current = zen;
    const pane = zenPane?.index ?? 0;
    const frame = requestAnimationFrame(() => {
      if (document.activeElement === document.body || document.activeElement === null) {
        focusPane(pane);
      }
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [zen, zenPane?.index]);

  const paneCount = panes.length;
  const { moveTab } = useTabTransfer(panes.map((pane) => pane.index));

  // F6 and Shift F6 cycle focus between the pane regions - see the hook for why it is claimed
  // only while there is more than one pane to cycle.
  usePaneCycling(zen ? 1 : paneCount);

  const close = useCallback(
    (index: number, title: string): void => {
      const left = paneCount - 1;
      announce(
        `Closed ${title || 'Untitled'}. ${left === 1 ? '1 pane' : `${String(left)} panes`} open.`,
      );
      closePane(index);

      // The tab store's own renumbering has to run from the same call site as the address's, or
      // a pane's tab strip ends up belonging to whichever pane used to sit at that index.
      paneClosed(index, paneCount);

      // The button that was focused is about to be unmounted with its pane, so focus goes to
      // whatever takes its place - the pane that shifts down into this index, or the last one
      // left. Without this it falls to the document body and the reader loses their place.
      focusPane(Math.min(index, left - 1));
    },
    [closePane, paneClosed, paneCount],
  );

  if (panes.length === 0) {
    return (
      <div
        id={paneElementId(0)}
        // Focusable only programmatically, the same as a real pane's `<article>` - this is pane
        // zero in every sense that matters to `focusPane(0)` and to the skip link, which lands
        // here when the drawer it just closed was covering Homebase rather than a pane.
        tabIndex={-1}
        className="flex min-w-0 flex-1 overflow-y-auto"
      >
        {tree.status === 'loading' ? (
          <Text variant="note" tone="muted" className="m-auto">
            Loading the workspace…
          </Text>
        ) : (
          <Homebase tree={tree} onImport={openImport} />
        )}
      </div>
    );
  }

  // What the address asked for but this window cannot draw. Saying nothing would mean somebody
  // opening a colleague's two-pane link on a phone sees one document with no sign that the message
  // held two - the interface knowing something it will not tell the reader.
  const hidden = (requested ?? panes.length) - panes.length;

  return (
    <div className={paneColumn}>
      {paneCount > 1 && !zen ? <PaneSplitControl orientation={split} onChange={setSplit} /> : null}
      {/* In Zen only the kept pane is handed over. Panes are keyed by their own index, so it keeps
          its place in the tree - and its editor its document, selection and scroll - rather than
          being rebuilt as the group shrinks around it. */}
      <PaneGroup
        panes={shownPanes}
        split={split}
        sizes={sizes}
        onSizes={setSizes}
        describePane={(pane) => describe(tree.find(pane.itemId)?.title, pane.index)}
        renderPane={(pane) => (
          <PaneContents
            pane={pane}
            tree={tree}
            visiblePanes={panes}
            draggedTab={draggedTab}
            onTabDragStarted={setDraggedTab}
            onTabDragEnded={() => {
              setDraggedTab(null);
            }}
            onMoveTab={moveTab}
            canManageTemplates={templateLibrary.capabilities.canManage}
            canApplyTemplates={
              templateLibrary.status === 'ready' &&
              templateLibrary.templates.some((template) => template.capabilities.canApply)
            }
            hiddenPanes={pane.index === 0 ? hidden : 0}
            paneLabel={
              paneCount > 1
                ? `Pane ${String(pane.index + 1)} of ${String(paneCount)}: ${describe(tree.find(pane.itemId)?.title, pane.index)}`
                : undefined
            }
            onFocused={setFocusedPane}
            onClose={
              paneCount > 1
                ? () => {
                    close(pane.index, tree.find(pane.itemId)?.title ?? '');
                  }
                : undefined
            }
          />
        )}
      />
    </div>
  );
}

/**
 * What to call a pane whose item has no title, or has not loaded yet.
 *
 * `?? ` alone does not catch an empty string, and an untitled note is ordinary - so a divider
 * would otherwise be announced as "Resize  and Notes", and two of them before the tree loads
 * would carry the same name as each other.
 */
function describe(title: string | undefined, index: number): string {
  return title !== undefined && title.length > 0 ? title : `pane ${String(index + 1)}`;
}
