import { Button, Text } from '@nix/ui';
import { useId, useRef, type ReactNode } from 'react';

import { EmptyPanel } from '@nix/web-foundation/components/states/status-panels';
import type { View } from '../core/container-model';
import type { ContainerData } from '../core/use-container';
import { ContainerNotices, resolveLoadState } from '../core/view-chrome';
import { ShownItems } from '../core/item-selection-context';
import { useClickSelects } from '../core/item-open-click';
import { useItemContextActions } from '../core/use-item-context-actions';
import { DraftField } from './outline-draft-field';
import { OutlineRowView } from './outline-row';
import { OutlineToolbar } from './outline-toolbar';
import { useOutlineSource, type OutlineSource } from './outline-source';
import { useOutlineTree } from './use-outline-tree';

/**
 * The outline (plan 3.8): the subtree as a collapsible tree of titles, reshaped from the keyboard.
 *
 * **The one view that edits structure.** Every other kind writes properties; this one adds items,
 * reparents them and reorders them, and it does all three through the item create and move
 * endpoints the sidebar already uses (`outline-source.ts`). So a lock, an item that accepts no
 * children and a move into its own subtree are refused by the same server code, and the refusal is
 * said on the row it was about rather than in a banner somebody has to connect back to it.
 *
 * **A real tree.** `role="tree"` with `treeitem`s that carry their level, position and expanded
 * state, and one roving tab stop: Up and Down move between visible rows, Right opens a row (its
 * children are read on the first open, never before) and Left closes it or steps to its parent.
 * Tab and Shift+Tab reparent the focused row, which is what an outliner's keyboard is for - so
 * Escape releases the next Tab, and that is how a keyboard leaves the tree.
 *
 * **Not only a keyboard.** The toolbar above the tree does each structural edit to the row last
 * focused, for a pointer and for a phone, which has no Tab key at all.
 */

export interface OutlineViewProps {
  readonly container: ContainerData;
  readonly view: View;
  readonly onOpen: (itemId: string) => void;
}

export function OutlineView(props: OutlineViewProps): ReactNode {
  const source = useOutlineSource();
  return <OutlineTree {...props} source={source} />;
}

/** The outline over any source; `OutlineView` supplies the real one. */
export interface OutlineTreeProps extends OutlineViewProps {
  readonly source: OutlineSource;
}

export function OutlineTree(props: OutlineTreeProps): ReactNode {
  const { container, view, onOpen, source } = props;
  const itemActions = useItemContextActions(onOpen);
  const clickSelects = useClickSelects();
  const tree = useOutlineTree(container, source);
  const releaseTab = useRef(false);
  const captionId = useId();

  const loadState = resolveLoadState(container, 'this outline');
  if (loadState !== null) return loadState;

  const { rootId, rows, activeRow, draft, busy, setDraft } = tree;

  // The field for a new sibling goes after the whole of the row it follows - after its open
  // children too - because that is where the new item will sit once it exists.
  const draftAnchor = ((): number => {
    if (draft?.afterId == null) return -1;
    const start = rows.findIndex(
      (row) => row.item.id === draft.afterId && row.parentId === draft.parentId,
    );
    if (start === -1) return -1;
    let end = start;
    const level = rows[start]?.level ?? 0;
    while ((rows[end + 1]?.level ?? 0) > level) end += 1;
    return end;
  })();

  const draftField =
    draft === null ? null : (
      <DraftField
        key={`${draft.parentId ?? 'root'}:${draft.afterId ?? 'first'}`}
        level={draft.level}
        onSubmit={(title) => tree.add(title, draft)}
        onCancel={tree.cancelDraft}
      />
    );

  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-3">
      <ShownItems ids={rows.map((row) => row.item.id)} />
      <ContainerNotices container={container} subject="this outline" />

      <OutlineToolbar
        row={activeRow}
        busy={busy}
        onOpen={() => {
          if (activeRow !== null) onOpen(activeRow.item.id);
        }}
        onAdd={() => {
          if (activeRow === null) {
            setDraft({ parentId: rootId, afterId: null, level: 1 });
          } else {
            setDraft({
              parentId: activeRow.parentId,
              afterId: activeRow.item.id,
              level: activeRow.level,
            });
          }
        }}
        onRename={() => {
          if (activeRow !== null) tree.startRename(activeRow.item.id);
        }}
        onIndent={() => {
          if (activeRow !== null) void tree.indent(activeRow);
        }}
        onOutdent={() => {
          if (activeRow !== null) void tree.outdent(activeRow);
        }}
        onUp={() => {
          if (activeRow !== null) void tree.reorder(activeRow, -1);
        }}
        onDown={() => {
          if (activeRow !== null) void tree.reorder(activeRow, 1);
        }}
      />

      <Text as="p" id={captionId} variant="caption" tone="muted" className="pointer-coarse:sr-only">
        Enter adds below. F2 renames. Tab and Shift+Tab indent and outdent. Ctrl or Cmd with Up and
        Down reorders. Escape, then Tab, leaves.
      </Text>

      {rows.length === 0 && draft === null ? (
        <EmptyPanel
          title="Nothing in this outline yet"
          detail="Add the first item, then press Enter for the next one and Tab to tuck it under."
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setDraft({ parentId: rootId, afterId: null, level: 1 });
              }}
            >
              Add the first item
            </Button>
          }
        />
      ) : (
        <div
          role="tree"
          aria-label={view.name}
          aria-describedby={captionId}
          aria-busy={busy}
          className="flex min-w-0 flex-col"
        >
          {draft !== null && draft.afterId === null ? draftField : null}
          {rows.map((row, position) => (
            <div key={row.item.id} role="none" className="flex min-w-0 flex-col">
              <OutlineRowView
                row={row}
                tree={tree}
                itemActions={itemActions}
                clickSelects={clickSelects}
                // The top level of a truncated container is a sample, so its size is not claimed.
                sizeKnown={!(row.level === 1 && container.truncated)}
                releaseTab={releaseTab}
                onOpen={onOpen}
              />
              {position === draftAnchor ? draftField : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
