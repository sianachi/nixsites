import { ContextMenu, Icon, Text, cn, focusRing, isEditableTarget } from '@nix/ui';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  IndentDecrease,
  IndentIncrease,
  Lock,
  Pencil,
  Plus,
} from 'lucide-react';
import type { RefObject, ReactNode } from 'react';

import { useOptionalItemSelection } from '../../collections/core/item-selection-context';
import { SelectCheckbox } from '../core/select-checkbox';
import { rowGestures } from '../../collections/core/use-item-selection';
import type { useItemContextActions } from '../../collections/core/use-item-context-actions';
import { RenameField } from './outline-rename-field';
import { onRowKeyDown } from './outline-keys';
import { titleOf, type OutlineRow } from './outline-model';
import type { OutlineTreeState } from './use-outline-tree';

interface OutlineRowViewProps {
  readonly row: OutlineRow;
  readonly tree: OutlineTreeState;
  readonly itemActions: ReturnType<typeof useItemContextActions>;
  readonly clickSelects: boolean;
  /** Whether the row's sibling count is a real total (a truncated top level is only a sample). */
  readonly sizeKnown: boolean;
  readonly releaseTab: RefObject<boolean>;
  readonly onOpen: (itemId: string) => void;
}

/** One tree row with its context menu: the disclosure, checkbox, title and the row's own note. */
export function OutlineRowView(props: OutlineRowViewProps): ReactNode {
  const { row, tree, itemActions, clickSelects, sizeKnown, releaseTab, onOpen } = props;
  const {
    busy,
    expanded,
    loading,
    locked,
    note,
    activeId,
    renamingId,
    rowRefs,
    setFocusedId,
    setDraft,
  } = tree;
  const selection = useOptionalItemSelection();
  const openBeside = selection?.openBeside;
  // A phone has no hover, so the boxes appear only once a long-press has started a selection.
  const selecting = selection !== null && selection.selected.size > 0;
  const id = row.item.id;
  const isOpen = expanded.has(id);
  const selectOrFocus = rowGestures(
    selection,
    id,
    selection?.shown ?? [],
    () => {
      setFocusedId(id);
    },
    openBeside === undefined
      ? undefined
      : () => {
          openBeside(id);
        },
    clickSelects,
  );
  const indentation = `min(${String((row.level - 1) * 1.5)}rem, 25%)`;
  return (
    <ContextMenu
      label={`${titleOf(row.item)} actions`}
      items={() =>
        itemActions(id, row.item.title, [
          {
            kind: 'action',
            label: 'Add item below',
            icon: Plus,
            disabled: busy,
            onSelect: () => {
              setDraft({ parentId: row.parentId, afterId: id, level: row.level });
            },
          },
          {
            kind: 'action',
            label: 'Rename',
            icon: Pencil,
            disabled: busy,
            onSelect: () => {
              tree.startRename(id);
            },
          },
          {
            kind: 'action',
            label: 'Indent',
            icon: IndentIncrease,
            disabled: busy,
            onSelect: () => {
              void tree.indent(row);
            },
          },
          {
            kind: 'action',
            label: 'Outdent',
            icon: IndentDecrease,
            disabled: busy,
            onSelect: () => {
              void tree.outdent(row);
            },
          },
          {
            kind: 'action',
            label: 'Move up',
            icon: ArrowUp,
            disabled: busy || row.index === 0,
            onSelect: () => {
              void tree.reorder(row, -1);
            },
          },
          {
            kind: 'action',
            label: 'Move down',
            icon: ArrowDown,
            disabled: busy || row.index === row.siblings.length - 1,
            onSelect: () => {
              void tree.reorder(row, 1);
            },
          },
        ])
      }
    >
      {(contextTarget) => (
        <div
          {...contextTarget}
          ref={(element) => {
            if (element === null) rowRefs.current.delete(id);
            else rowRefs.current.set(id, element);
          }}
          role="treeitem"
          aria-level={row.level}
          aria-setsize={sizeKnown ? row.siblings.length : -1}
          aria-posinset={row.index + 1}
          aria-selected={id === activeId}
          {...(row.item.hasChildren ? { 'aria-expanded': isOpen } : {})}
          tabIndex={id === activeId ? 0 : -1}
          onFocus={() => {
            setFocusedId(id);
          }}
          onClick={(event) => {
            setFocusedId(id);
            if (isEditableTarget(event.target)) return;
            selectOrFocus.onClick(event);
          }}
          onKeyDown={(event) => {
            if (isEditableTarget(event.target)) return;
            selectOrFocus.onKeyDown(event);
            if (event.defaultPrevented) return;
            onRowKeyDown(event, row, tree, releaseTab, onOpen);
          }}
          onKeyUp={(event) => {
            if (!isEditableTarget(event.target)) selectOrFocus.onKeyUp(event);
          }}
          onDoubleClick={() => {
            tree.startRename(id);
          }}
          className={cn(
            'group flex min-h-(--control-sm) min-w-0 flex-wrap items-center gap-1 rounded-sm py-1 pointer-coarse:min-h-(--control-lg)',
            id === activeId ? 'bg-foreground/7' : '',
            focusRing,
          )}
          style={{ paddingInlineStart: indentation }} // design-token-exempt: tree-depth indentation is capped relative to available width so deep titles remain readable
        >
          {/* The disclosure is a pointer convenience over what Right and Left already do,
                      so it is not a second tab stop inside the row. */}
          <span
            aria-hidden="true"
            onClick={() => {
              if (!row.item.hasChildren) return;
              if (isOpen) tree.close(row.item);
              else void tree.open(row.item);
            }}
            className="inline-flex size-(--control-sm) shrink-0 items-center justify-center text-muted pointer-coarse:size-(--control-lg)"
          >
            {row.item.hasChildren ? (
              <Icon icon={isOpen ? ChevronDown : ChevronRight} size="sm" />
            ) : null}
          </span>
          <span className={cn('contents', !selecting && 'pointer-coarse:hidden')}>
            <SelectCheckbox item={row.item} />
          </span>
          {renamingId === id ? (
            <RenameField
              title={row.item.title}
              onCommit={(title) => void tree.rename(row, title)}
              onCancel={() => {
                tree.cancelRename(id);
              }}
            />
          ) : (
            <Text as="span" variant="body" className="min-w-0 flex-1">
              {titleOf(row.item)}
            </Text>
          )}
          {locked.has(id) ? (
            <>
              <Icon icon={Lock} size="sm" className="text-muted" />
              <span className="sr-only">, locked</span>
            </>
          ) : null}
          {loading.has(id) ? (
            <Text as="span" variant="caption" tone="muted">
              Loading
            </Text>
          ) : null}
          {/* Inside the row it is about, so the tree owns only rows and the new-item
                      group, and a screen reader hears the note as part of the row. */}
          {note !== null && note.itemId === id ? (
            <Text as="span" variant="caption" tone="accent" role="alert" className="basis-full">
              {note.text}
            </Text>
          ) : null}
        </div>
      )}
    </ContextMenu>
  );
}
