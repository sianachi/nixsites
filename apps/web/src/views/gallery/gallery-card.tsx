import { Button, ContextMenu, Icon, Text, blueprintFrame, cn, focusRing } from '@nix/ui';
import { ImagePlus } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  readPropertyText,
  type Item,
  type PropertyDefinition,
  type PropertyValue,
} from '../../collections/core/container-model';
import { useClickSelects } from '../../collections/core/item-open-click';
import { useOptionalItemSelection } from '../../collections/core/item-selection-context';
import { SelectCheckbox } from '../core/select-checkbox';
import { ValuePopover } from '../../collections/properties/value-popover';
import { useItemContextActions } from '../../collections/core/use-item-context-actions';
import { rowGestures } from '../../collections/core/use-item-selection';
import { FileThumbnail } from '../../collections/thumbnails';
import { ListCell } from '../list/list-cell';
import { CARD_SIZE_COVER, type CardSize } from './card-size';
import { CoverPane } from './cover-pane';
import type { Cover } from './gallery-cover';

interface GalleryCardProps {
  readonly item: Item;
  readonly cover: Cover;
  readonly size: CardSize;
  readonly secondary: readonly string[];
  readonly schema: readonly PropertyDefinition[];
  readonly onOpen: (itemId: string) => void;
  readonly onWrite: (
    itemId: string,
    propertyKey: string,
    value: PropertyValue,
  ) => Promise<string | null>;
  readonly coverFailed: boolean;
  readonly onCoverFailure: () => void;
  readonly onRequestCover: () => void;
  readonly position: number;
  readonly setSize: number;
  readonly virtualIndex?: number;
}

export function GalleryCard(props: GalleryCardProps): ReactNode {
  const {
    item,
    cover,
    size,
    secondary,
    schema,
    onOpen,
    onWrite,
    coverFailed,
    onCoverFailure,
    onRequestCover,
    position,
    setSize,
    virtualIndex,
  } = props;
  const itemActions = useItemContextActions(onOpen);
  const selection = useOptionalItemSelection();
  const clickSelects = useClickSelects();
  const isSelected = selection?.selected.has(item.id) === true;
  const isFileCard = item.type === 'file' && !item.hasChildren;
  const coverValue = cover.kind === 'ready' ? readPropertyText(item, cover.property.key) : '';

  // Each field is a value; an empty one shows its name so it can be filled in from the card.
  // Editing is the cell's own editor in a popover, as in the phone list.
  const fields = secondary.flatMap((key) => {
    const definition = schema.find((entry) => entry.key === key);
    return definition === undefined ? [] : [definition];
  });

  return (
    // `blueprintFrame` composed directly rather than `<Blueprint className="bg-surface">`: that
    // component's `className` is documented as layout only, with its border, corners and
    // *transparency* being its contract, so passing a fill through it is the restyle the doc
    // forbids. `Card` in packages/ui composes the frame the same way for the same reason.
    //
    // `relative` is load-bearing - it is what the title button's stretched hit area is measured
    // against - and `shadow-sm` is the resting elevation every other card in the product has.
    <ContextMenu
      label={`${item.title || 'Untitled'} actions`}
      // A touch long-press starts a selection; once one exists it opens the card menu as before.
      onLongPress={() => {
        if (selection === null || selection.selected.size > 0) return false;
        selection.toggle(item.id, selection.shown);
        return true;
      }}
      items={() =>
        itemActions(item.id, item.title, [
          {
            kind: 'action',
            label: coverValue.length > 0 ? 'Change cover' : 'Set cover',
            icon: ImagePlus,
            onSelect: onRequestCover,
          },
        ])
      }
    >
      {(contextTarget) => (
        <li
          {...contextTarget}
          {...(virtualIndex === undefined ? {} : { role: 'listitem' })}
          aria-posinset={position}
          aria-setsize={setSize}
          data-virtual-index={virtualIndex}
          className={cn(
            blueprintFrame,
            'group relative flex min-w-0 flex-col gap-2 bg-surface p-3 shadow-sm',
            isSelected && 'bg-accent/10 outline-2 -outline-offset-2 outline-accent',
          )}
        >
          {/* The selection box, in the card's corner: drawn on hover or focus until something is
              selected, then on every card. Touch starts a selection with a long press, so the box
              is not the only way in. `z-20` lifts it above the title's stretched hit area. */}
          <SelectCheckbox
            item={item}
            className="absolute left-2 top-2 z-20 rounded-md bg-surface"
          />
          {/* **The title comes first in the DOM and the picture is moved above it visually.** A screen
          reader reading in source order would otherwise meet "No cover" before it had been told
          which item that was about - the status arriving ahead of its subject. `order-first` puts
          the picture back on top for everyone reading with their eyes. */}
          {/* A real heading, so a card grid can be walked by heading rather than only by tabbing
          through every title in it. A gallery is the view where that matters most - it is a page of
          named things and nothing else - and a `span` styled to look like a heading gives a screen
          reader user no way through it. The control lives inside the heading so both the outline
          and the affordance survive. */}
          <h3 className="min-w-0 pr-(--control-lg)">
            <button
              type="button"
              {...rowGestures(
                selection,
                item.id,
                selection?.shown ?? [],
                () => {
                  onOpen(item.id);
                },
                selection?.openBeside === undefined
                  ? undefined
                  : () => {
                      selection.openBeside?.(item.id);
                    },
                clickSelects,
              )}
              // The card is mostly picture, and in a gallery the picture *is* the affordance - it is
              // why somebody chose this view. A stretched pseudo-element makes the whole card clickable
              // while the accessible tree keeps exactly one control per card; a second click target on
              // the image would be two controls with one name.
              className={cn(
                'w-full text-left after:absolute after:inset-0 after:content-[""]',
                focusRing,
              )}
            >
              <Text variant="h5" as="span" lines={2}>
                {item.title || 'Untitled'}
              </Text>
            </button>
          </h3>

          {/* **Always on screen, never only on hover.** A hover-revealed control is invisible to a
          tap - there is no hover state on a touch screen - which was the whole of the complaint
          this answers: "no easy way to put images on grids". `z-20` clears the title button's
          stretched hit area above it (see the `z-10` note on the fields below, which faces the
          same problem one layer down) and the `bg-surface` wrapper is what keeps a transparent
          icon button legible sitting on top of an arbitrary photograph. */}
          <div className="absolute right-2 top-2 z-20 rounded-md bg-surface">
            <Button
              variant="icon"
              aria-label={
                cover.kind === 'ready' && readPropertyText(item, cover.property.key).length > 0
                  ? `Change cover for ${item.title || 'Untitled'}`
                  : `Set cover for ${item.title || 'Untitled'}`
              }
              onClick={onRequestCover}
              aria-haspopup="dialog"
            >
              <Icon icon={ImagePlus} size="sm" />
            </Button>
          </div>

          {/* Nothing at all when no cover was asked for. A grey rectangle here would be a placeholder
          for a picture that was never coming, which reads as a load that never finished. */}
          {/* A file with no cover of its own - none configured, or none set on this card - draws its
          thumbnail, or a glyph for its kind, in the same frame a cover would fill. A configured
          cover that has a value always wins, working or not: it is somebody's explicit choice, and
          a broken one must say so rather than quietly show something else. */}
          {isFileCard && coverValue.length === 0 ? (
            <div className="order-first">
              <FileThumbnail
                itemId={item.id}
                // The title is the file's name for a file item, and it is all a gallery has: it holds no
                // file records, so there is no media type, byte length or version to give. `undefined`
                // is what tells the hook to ask the server, and only for a type that can have one.
                fileName={item.title}
                mediaType=""
                version={null}
                hasServerThumbnail={undefined}
                className={cn('w-full', CARD_SIZE_COVER[size])}
                iconSize="lg"
              />
            </div>
          ) : cover.kind === 'ready' ? (
            <div className="order-first">
              <CoverPane
                src={coverValue}
                label={cover.property.label}
                size={size}
                failed={coverFailed}
                onFailure={onCoverFailure}
              />
            </div>
          ) : null}

          {fields.length === 0 ? null : (
            // `relative z-10`: the title button's `after:absolute after:inset-0` stretched hit area
            // sits on top of the card in DOM order, and without a stacking context of its own this
            // layer would swallow every click a field control below it is meant to receive - a tap
            // meant for a select or a checkbox opening the item instead.
            <div className="relative z-10 -mx-2 flex flex-wrap gap-x-1">
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
        </li>
      )}
    </ContextMenu>
  );
}
