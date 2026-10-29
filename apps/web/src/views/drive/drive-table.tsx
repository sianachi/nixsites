import { ContextMenu, Icon, Text, cn, focusRing } from '@nix/ui';
import { ArrowDown, ArrowUp, ChevronsUpDown, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { formatBytes, formatWhen } from '../../collections/items/file-facts';
import { useOptionalItemSelection } from '../../collections/core/item-selection-context';
import { SelectCheckbox } from '../core/select-checkbox';
import { rowGestures } from '../../collections/core/use-item-selection';
import { driveKindIcon } from './drive-icons';
import { DriveFileThumbnail } from './drive-file-thumbnail';
import { DriveRowActions } from './drive-row-actions';
import { isFileRow, rowDetail, type RowsProps } from './drive-rows';
import { kindOf, type SortKey, type SortState } from './drive-sort';

export function DriveTable(
  props: RowsProps & { readonly sort: SortState; readonly onChangeSort: (key: SortKey) => void },
): ReactNode {
  const {
    rows,
    fileInfo,
    sort,
    dropTargetRow,
    onOpen,
    rowContextMenu,
    onChangeSort,
    onDragStart,
    onDragOver,
    onDragEnd,
    onDrop,
  } = props;
  const selection = useOptionalItemSelection();
  const openBeside = selection?.openBeside;
  const order = rows.map((item) => item.id);

  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full table-fixed border-collapse text-left @2xl/drive:table-auto">
        <caption className="sr-only">This drive's contents</caption>
        <thead>
          <tr>
            <th scope="col" className="w-(--control-lg) border-b border-divider p-2">
              {selection === null ? null : <span className="sr-only">Select</span>}
            </th>
            <SortableHeader label="Name" columnKey="name" sort={sort} onChangeSort={onChangeSort} />
            {/* Kind and Modified are context, not identity - on a phone-width table that scrolls
                sideways instead of wrapping, they are the columns to drop first, keeping Name and
                the one detail (Size) that fits without a horizontal scroll. */}
            <SortableHeader
              label="Kind"
              columnKey="kind"
              sort={sort}
              onChangeSort={onChangeSort}
              className="hidden @2xl/drive:table-cell"
            />
            <SortableHeader
              label="Size"
              columnKey="size"
              sort={sort}
              onChangeSort={onChangeSort}
              align="end"
              className="hidden @2xl/drive:table-cell"
            />
            <SortableHeader
              label="Modified"
              columnKey="modified"
              sort={sort}
              onChangeSort={onChangeSort}
              align="end"
              className="hidden @2xl/drive:table-cell"
            />
            <th scope="col" className="w-14 border-b border-divider p-0">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => {
            const info = fileInfo.get(item.id);
            const RowIcon = driveKindIcon(item);
            const isSelected = selection?.selected.has(item.id) === true;
            const openProps = rowGestures(
              selection,
              item.id,
              order,
              () => {
                onOpen(item.id);
              },
              openBeside === undefined
                ? undefined
                : () => {
                    openBeside(item.id);
                  },
            );
            return (
              <ContextMenu
                key={item.id}
                label={`${item.title || 'Untitled'} actions`}
                items={() => rowContextMenu(item)}
              >
                {(contextTarget) => (
                  <tr
                    {...contextTarget}
                    draggable
                    onDragStart={(event) => {
                      onDragStart(item, event);
                    }}
                    onDragOver={(event) => {
                      onDragOver(item, event);
                    }}
                    onDragEnd={onDragEnd}
                    onDrop={(event) => {
                      onDrop(item, event);
                    }}
                    className={cn(
                      'group',
                      isSelected && 'bg-accent/10',
                      dropTargetRow === item.id && 'outline-2 -outline-offset-2 outline-accent',
                    )}
                  >
                    <td className="border-b border-divider p-2">
                      <SelectCheckbox item={item} />
                    </td>
                    <td className="border-b border-divider p-2">
                      <button
                        type="button"
                        {...openProps}
                        className={cn(
                          'flex min-h-(--control-sm) w-full min-w-0 items-center gap-2 text-left pointer-coarse:min-h-(--control-lg)',
                          focusRing,
                        )}
                      >
                        {isFileRow(item) ? (
                          <DriveFileThumbnail
                            item={item}
                            info={info}
                            className="size-8 shrink-0"
                            iconSize="sm"
                          />
                        ) : (
                          <Icon icon={RowIcon} size="sm" />
                        )}
                        <Text variant="body" as="span" className="min-w-0 flex-1 wrap-anywhere">
                          {item.title || 'Untitled'}
                        </Text>
                      </button>
                      {/* The dropped Kind and Size columns as one line, outside the button so the
                          button stays named by the title; shown only where there is no room for them. */}
                      <div className="pl-10 @2xl/drive:hidden">
                        <Text variant="caption" as="span" tone="muted">
                          {rowDetail(item, info)}
                        </Text>
                      </div>
                    </td>
                    <td className="hidden border-b border-divider p-2 @2xl/drive:table-cell">
                      <Text variant="body" as="span" tone="muted">
                        {kindOf(item, info)}
                      </Text>
                    </td>
                    <td className="hidden border-b border-divider p-2 text-right @2xl/drive:table-cell">
                      <Text variant="body" as="span" tone="muted">
                        {item.type === 'file'
                          ? info?.status === 'ready'
                            ? formatBytes(info.record.current.byteLength)
                            : '—'
                          : '—'}
                      </Text>
                    </td>
                    <td className="hidden border-b border-divider p-2 text-right @2xl/drive:table-cell">
                      <Text variant="body" as="span" tone="muted">
                        {formatWhen(item.updatedAt)}
                      </Text>
                    </td>
                    <td className="border-b border-divider p-1">
                      <DriveRowActions item={item} rowContextMenu={rowContextMenu} />
                    </td>
                  </tr>
                )}
              </ContextMenu>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SortableHeader({
  label,
  columnKey,
  sort,
  onChangeSort,
  align = 'start',
  className,
}: {
  readonly label: string;
  readonly columnKey: SortKey;
  readonly sort: SortState;
  readonly onChangeSort: (key: SortKey) => void;
  readonly align?: 'start' | 'end';
  readonly className?: string;
}): ReactNode {
  const sorted = sort.key === columnKey;
  const glyph: LucideIcon = sorted
    ? sort.direction === 'ascending'
      ? ArrowUp
      : ArrowDown
    : ChevronsUpDown;

  return (
    <th
      scope="col"
      aria-sort={sorted ? sort.direction : 'none'}
      className={cn(
        'border-b border-divider p-0',
        align === 'end' ? 'text-right' : 'text-left',
        className,
      )}
    >
      <button
        type="button"
        onClick={() => {
          onChangeSort(columnKey);
        }}
        className={cn(
          'flex min-h-(--control-sm) w-full items-center gap-1 p-2 pointer-coarse:min-h-(--control-lg)',
          align === 'end' ? 'justify-end' : 'justify-start',
          focusRing,
        )}
      >
        <Text variant="kicker" as="span">
          {label}
        </Text>
        <Icon icon={glyph} size="sm" />
      </button>
    </th>
  );
}
