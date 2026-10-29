import { Text, cn } from '@nix/ui';
import type { ReactNode } from 'react';

import { dayLabel, dayText, type CalendarDay } from '../../../collections/core/calendar-dates';
import { readPropertyText, type Item } from '../../../collections/core/container-model';
import { CreateItemControl } from '../../core/create-item-control';
import { useItemOpenProps } from '../../../collections/core/item-open-click';
import { CalendarEntryMenu } from '../calendar-entry-menu';
import { DAY_COLUMN, HOUR_GUTTER } from './geometry';

/**
 * The band above the hours, for items that have a date rather than a moment.
 *
 * They are not placed by time because they do not have one. Putting them at midnight would be an
 * invented answer that reads as a real one.
 */
export function AllDayBand(props: {
  readonly days: readonly CalendarDay[];
  readonly items: readonly Item[];
  readonly dateProperty: string;
  readonly onOpen: (itemId: string) => void;
  /**
   * Adds an item to the day or slot it is offered on.
   *
   * Optional, and absent means the grid offers no way to create. The collated calendar reads across
   * containers, so "create here" has no answer - there is no one container a new item would belong
   * to. A control that appeared and did nothing would be worse than no control.
   */
  readonly onCreate?:
    ((title: string, properties?: Record<string, unknown>) => Promise<string | null>) | undefined;
}): ReactNode {
  const { days, items, dateProperty, onOpen, onCreate } = props;
  const openProps = useItemOpenProps(onOpen);

  return (
    <div className="flex border-y border-divider">
      <span aria-hidden="true" className={cn(HOUR_GUTTER, 'pr-1 text-right')}>
        <Text variant="caption" as="span" tone="muted">
          All day
        </Text>
      </span>

      {days.map((day) => {
        const wanted = dayText(day);
        const allDay = items.filter((item) => item.properties[dateProperty] === wanted);

        return (
          <div
            key={wanted}
            aria-label={`All day on ${dayLabel(day)}`}
            // `flex flex-col gap-2` rather than a plain block: the chips below extend their hit
            // area 3.4px past each edge, so two stacked chips with no gap between them would
            // overlap by 6.8px and the later sibling would paint over it - the bottom of every
            // chip opening the item below it. WCAG 2.5.8's spacing exception is about area that
            // belongs to nobody else, so borrowing it from the neighbour does not satisfy the
            // floor. gap-2 is 6.8px, exactly the two 3.4px extensions, so they meet and never
            // overlap. The create control below the chips extends 1.7px (`-inset-y-0.5`), well
            // inside the same gap.
            className={cn(
              DAY_COLUMN,
              // The "bordered group -> p-3" role names a *panel* - a bordered box standing on the
              // page, like the board's column or the timeline's off-axis list. This is a cell in a
              // band of seven, and its `border-l` is the rule between two columns rather than a
              // frame around one. p-3 here would be 24px of padding inside a 112px column, most of
              // the width of the chips it holds; this row of cells has always been p-1 and its
              // neighbour, the hour gutter, pads to match.
              'group/allday flex flex-col gap-2 border-l border-divider p-1', // spacing-role-exempt: a band cell, not a panel - see above
            )}
          >
            {allDay.map((item) => (
              <CalendarEntryMenu
                key={item.id}
                itemId={item.id}
                title={readPropertyText(item, 'title')}
                onOpen={onOpen}
              >
                {(contextTarget) => (
                  /* `relative before:*`: the drawn chip is about 19px tall (`text-xs` at its 1.4 line
                 height plus `py-0.5`), under WCAG 2.5.8's 24px floor, and making it taller would
                 push the band's rows apart. The pseudo-element widens what a pointer has to hit
                 without widening what the eye sees - the same technique, with the same reasoning,
                 as @nix/ui's PaneDivider grab band. `-inset-y-1` is one spacing step (3.4px) past
                 each edge, which clears the floor with room for the density to tighten. The
                 column's `gap-2` is what gives those extensions somewhere to go; see it above. */
                  <button
                    {...contextTarget}
                    type="button"
                    {...openProps(item.id)}
                    className="relative block w-full truncate rounded-sm bg-accent/18 px-1.5 py-0.5 text-left text-xs before:absolute before:inset-x-0 before:-inset-y-1 hover:bg-accent/25 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                  >
                    {readPropertyText(item, 'title')}
                  </button>
                )}
              </CalendarEntryMenu>
            ))}

            {/* `opacity-0`/`pointer-events-none`, not `invisible` - see the hour cell's own
                control above for why `visibility: hidden` breaks the keyboard path entirely.
                `pointer-coarse:*` keeps it shown and tappable on a phone, for the same reason as
                the hour cell's own control. */}
            {onCreate !== undefined && (
              <CreateItemControl
                compact
                label={`Add an all-day item on ${dayLabel(day)}`}
                properties={{ [dateProperty]: wanted }}
                onCreate={onCreate}
                className="opacity-0 pointer-events-none focus-within:pointer-events-auto focus-within:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/allday:pointer-events-auto group-hover/allday:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
