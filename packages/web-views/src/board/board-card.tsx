import { ArrowRightLeft } from 'lucide-react';
import { Button, ContextMenu, Blueprint, Icon, Menu, Text, cn, focusRing } from '@nix/ui';
import { useRef, type ReactNode } from 'react';

import type { StaleMember } from '@nix/web-foundation/lib/suggest/staleness';
import {
  readSelectValue,
  type Item,
  type PropertyDefinition,
  type PropertyValue,
} from '@nix/web-collections/core/container-model';
import { useItemOpenProps } from '@nix/web-collections/core/item-open-click';
import { useOptionalItemSelection } from '@nix/web-collections/core/item-selection-context';
import { SelectCheckbox } from '../core/select-checkbox';
import { useItemContextActions } from '@nix/web-collections/core/use-item-context-actions';
import { ValuePopover } from '@nix/web-collections/properties/value-popover';
import { ListCell } from '../list/list-cell';
import { staleDismissalKey, type BoardColumn } from './board-grouping';
import { StaleCardHint } from './stale-card-hint';

export interface BoardCardListProps {
  readonly items: readonly Item[];
  readonly label: string;
  readonly columns: readonly BoardColumn[];
  readonly property: PropertyDefinition;
  readonly cardProperties: readonly string[];
  readonly schema: readonly PropertyDefinition[];
  readonly dragged: string | null;
  readonly setDragged: (itemId: string | null) => void;
  readonly onMove: (item: Item, value: string | null) => void;
  readonly onWrite: (
    itemId: string,
    propertyKey: string,
    value: PropertyValue,
  ) => Promise<string | null>;
  readonly onOpen: (itemId: string) => void;
  readonly stale: ReadonlyMap<string, StaleMember>;
  readonly dismissedStale: ReadonlySet<string>;
  readonly onDismissStale: (item: Item) => void;
}

export function boardCard(
  props: BoardCardListProps,
  item: Item,
  index: number,
  virtualIndex?: number,
): ReactNode {
  return (
    <BoardCard
      key={item.id}
      item={item}
      columns={props.columns}
      property={props.property}
      cardProperties={props.cardProperties}
      schema={props.schema}
      dragging={props.dragged === item.id}
      setDragged={props.setDragged}
      onMove={props.onMove}
      onWrite={props.onWrite}
      onOpen={props.onOpen}
      columnLabel={props.label}
      stale={
        props.dismissedStale.has(staleDismissalKey(item)) ? undefined : props.stale.get(item.id)
      }
      onDismissStale={props.onDismissStale}
      position={index + 1}
      setSize={props.items.length}
      {...(virtualIndex === undefined ? {} : { virtualIndex })}
    />
  );
}

interface BoardCardProps extends Pick<
  BoardCardListProps,
  | 'columns'
  | 'property'
  | 'cardProperties'
  | 'schema'
  | 'setDragged'
  | 'onMove'
  | 'onWrite'
  | 'onOpen'
  | 'onDismissStale'
> {
  readonly item: Item;
  readonly dragging: boolean;
  readonly position: number;
  readonly setSize: number;
  readonly virtualIndex?: number;

  /** The column the card sits in, for the stale note's sentence. */
  readonly columnLabel: string;

  /** Set when the card has gone untouched far longer than its column's usual and not been waved off. */
  readonly stale: StaleMember | undefined;
}

function BoardCard(props: BoardCardProps): ReactNode {
  const {
    item,
    columns,
    property,
    cardProperties,
    schema,
    dragging,
    setDragged,
    onMove,
    onWrite,
    onOpen,
    position,
    setSize,
    virtualIndex,
    columnLabel,
    stale,
    onDismissStale,
  } = props;
  const itemActions = useItemContextActions(onOpen);
  const openProps = useItemOpenProps(onOpen);
  const selection = useOptionalItemSelection();
  const isSelected = selection?.selected.has(item.id) === true;
  const selecting = selection !== null && selection.selected.size > 0;

  const current = readSelectValue(item, property.key);
  const titleRef = useRef<HTMLButtonElement>(null);

  // The view's `columns` are the properties worth showing on a card face, each as its label and an
  // editable value - an empty one included, so a value can be filled in from the card.
  const fields = cardProperties.flatMap((candidate) => {
    const definition = schema.find((entry) => entry.key === candidate);
    return definition === undefined ? [] : [definition];
  });

  // Drag is desktop-only, so a column move needs a menu path for keyboard and touch. One entry per
  // other column (not "Move to…", which is the tree move every view has). Offered twice: from the
  // context menu, and from a visible button on the card for touch and assistive technology.
  const moveItems = columns
    .filter((column) => column.value !== current)
    .map((column) => ({
      kind: 'action' as const,
      label: `Move to ${column.label}`,
      onSelect: () => {
        onMove(item, column.value);
        // The card re-mounts in its new column; hand focus to it there, if it is on screen.
        requestAnimationFrame(() => {
          document
            .querySelector<HTMLElement>(`[data-board-card="${CSS.escape(item.id)}"] button`)
            ?.focus();
        });
      },
    }));

  return (
    <ContextMenu
      label={`${item.title || 'Untitled'} actions`}
      items={() => itemActions(item.id, item.title, moveItems)}
    >
      {(contextTarget) => (
        <li
          {...contextTarget}
          {...(virtualIndex === undefined ? {} : { role: 'listitem' })}
          aria-posinset={position}
          aria-setsize={setSize}
          data-board-card={item.id}
          data-virtual-index={virtualIndex}
          className="group min-w-0"
        >
          <Blueprint
            className={cn(
              'flex flex-col gap-1.5 bg-background p-3',
              dragging ? 'opacity-45' : '',
              isSelected && 'bg-accent/10 outline-2 -outline-offset-2 outline-accent',
            )}
          >
            <div className="relative flex items-start gap-2">
              {/* Beside the draggable title, not inside it, so pressing the box never starts a drag. */}
              {/* Idle it overlaps the title on hover/focus; selecting or on touch it takes its own column. */}
              <SelectCheckbox
                item={item}
                className={cn(
                  !selecting &&
                    'absolute left-0 top-0 z-10 bg-background pointer-events-none focus-within:pointer-events-auto group-hover:pointer-events-auto pointer-coarse:pointer-events-auto pointer-coarse:static pointer-coarse:opacity-100',
                )}
              />
              <div
                className="min-w-0 flex-1"
                draggable
                onDragStart={(event) => {
                  setDragged(item.id);
                  event.dataTransfer.effectAllowed = 'move';
                  // Set, though the drop handler prefers its own state: without data attached, Firefox
                  // refuses to start the drag at all.
                  event.dataTransfer.setData('text/plain', item.id);
                }}
                onDragEnd={() => {
                  setDragged(null);
                }}
              >
                <button
                  ref={titleRef}
                  type="button"
                  {...openProps(item.id)}
                  className={cn('w-full text-left', focusRing)}
                >
                  <Text variant="h5" as="span" lines={2}>
                    {item.title || 'Untitled'}
                  </Text>
                </button>
              </div>
              {moveItems.length === 0 ? null : (
                <Menu label={`Move ${item.title || 'Untitled'} to column`} items={moveItems}>
                  {(trigger) => (
                    <Button
                      {...trigger}
                      variant="subtle"
                      aria-label={`Move ${item.title || 'Untitled'} to column`}
                    >
                      <Icon icon={ArrowRightLeft} size="sm" />
                    </Button>
                  )}
                </Menu>
              )}
            </div>

            {stale === undefined ? null : (
              <StaleCardHint
                title={item.title}
                columnLabel={columnLabel}
                ageMs={stale.ageMs}
                medianMs={stale.medianMs}
                onDismiss={() => {
                  onDismissStale(item);
                  // The dismiss button goes with the note; focus lands on the card it was about
                  // rather than falling to the document (WCAG 2.4.3).
                  titleRef.current?.focus();
                }}
              />
            )}

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
