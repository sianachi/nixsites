import { Blueprint, Button, ContextMenu, Icon, Menu, Text, cn, focusRing } from '@nix/ui';
import { ArrowRightLeft } from 'lucide-react';
import type { ReactNode } from 'react';

import type {
  Item,
  PropertyDefinition,
  PropertyValue,
} from '../../collections/core/container-model';
import { useItemOpenProps } from '../../collections/core/item-open-click';
import { useItemContextActions } from '../../collections/core/use-item-context-actions';
import { ValuePopover } from '../../collections/properties/value-popover';
import { ListCell } from '../list/list-cell';
import { cellValue, type CellAddress } from './matrix-axes';

export interface CellChoice {
  readonly address: CellAddress;
  readonly label: string;
}

export interface MatrixCardProps {
  readonly item: Item;
  readonly current: CellAddress;
  readonly cells: readonly CellChoice[];
  readonly fields: readonly PropertyDefinition[];
  readonly dragging: boolean;
  readonly titleRef: (element: HTMLButtonElement | null) => void;
  readonly onDragStart: () => void;
  readonly onDragEnd: () => void;
  readonly onMove: (to: CellAddress) => void;
  readonly onWrite: (
    itemId: string,
    propertyKey: string,
    value: PropertyValue,
  ) => Promise<string | null>;
  readonly onOpen: (itemId: string) => void;
}

export function MatrixCard(props: MatrixCardProps): ReactNode {
  const {
    item,
    current,
    cells,
    fields,
    dragging,
    titleRef,
    onDragStart,
    onDragEnd,
    onMove,
    onWrite,
    onOpen,
  } = props;
  const itemActions = useItemContextActions(onOpen);
  const openProps = useItemOpenProps(onOpen);
  const title = item.title.length > 0 ? item.title : 'Untitled';

  return (
    <ContextMenu label={`${title} actions`} items={() => itemActions(item.id, item.title)}>
      {(contextTarget) => (
        <li {...contextTarget} className="min-w-0">
          <Blueprint
            className={cn('flex flex-col gap-1.5 bg-background p-3', dragging ? 'opacity-45' : '')}
          >
            <div className="flex items-start gap-1">
              <div
                className="min-w-0 flex-1"
                draggable
                onDragStart={(event) => {
                  onDragStart();
                  event.dataTransfer.effectAllowed = 'move';
                  // Without data attached, Firefox refuses to start the drag at all.
                  event.dataTransfer.setData('text/plain', item.id);
                }}
                onDragEnd={onDragEnd}
              >
                <button
                  ref={titleRef}
                  type="button"
                  {...openProps(item.id)}
                  className={cn(
                    'min-w-0 w-full text-left any-pointer-coarse:min-h-(--control-lg)',
                    focusRing,
                  )}
                >
                  <Text variant="h5" as="span" lines={2}>
                    {title}
                  </Text>
                </button>
              </div>

              {/* A menu of cells rather than a select: a select commits on a single arrow press and
                  drops focus when the card leaves its cell, while a menu commits only on a choice. */}
              <Menu
                label={`Move ${title} to`}
                items={cells.map((cell) => ({
                  key: cellValue(cell.address),
                  label: cell.label,
                  disabled: cellValue(cell.address) === cellValue(current),
                  onSelect: () => {
                    onMove(cell.address);
                  },
                }))}
              >
                {(trigger) => (
                  <Button {...trigger} variant="icon" aria-label={`Move ${title} to`}>
                    <Icon icon={ArrowRightLeft} size="sm" />
                  </Button>
                )}
              </Menu>
            </div>

            {fields.length === 0 ? null : (
              <div className="-mx-2 flex flex-col">
                {fields.map((field) => (
                  <ValuePopover
                    key={field.key}
                    item={item}
                    property={field}
                    density="chip"
                    labelled
                    className="max-w-full"
                  >
                    <ListCell
                      item={item}
                      property={field}
                      density="card"
                      onWrite={(value) => onWrite(item.id, field.key, value)}
                    />
                  </ValuePopover>
                ))}
              </div>
            )}
          </Blueprint>
        </li>
      )}
    </ContextMenu>
  );
}
