import { Button, Text, cn, focusRing } from '@nix/ui';
import type { ReactNode } from 'react';

import { CalendarEntryMenu } from '../calendar/calendar-entry-menu';
import { SelectCheckbox } from '../core/select-checkbox';
import type { AsideContext, Placed } from './timeline-model';
import { titleOf } from './timeline-model';
import { announce, spoken } from './timeline-text';
import { useTimelineOpenProps } from './use-timeline-open-props';

/** What the date button says: the end when there is one, otherwise the way to add what is missing. */
function datesLabel(placed: Placed, hasEndProperty: boolean): string {
  if (placed.end !== null && placed.end !== placed.start) {
    return `Until ${spoken(placed.end)}`;
  }
  if (placed.start === null) {
    return 'Add start date';
  }
  return hasEndProperty && placed.end === null ? 'Add end date' : 'Change date';
}

function AgendaRow({
  placed,
  aside,
}: {
  readonly placed: Placed;
  readonly aside: AsideContext;
}): ReactNode {
  const { item } = placed;
  const openProps = useTimelineOpenProps(aside.onOpen);

  return (
    <CalendarEntryMenu
      itemId={item.id}
      title={titleOf(item)}
      onOpen={aside.onOpen}
      onReschedule={aside.setRescheduling}
    >
      {(contextTarget) => (
        <li {...contextTarget} className="group flex min-w-0 flex-col py-1">
          <div className="flex items-center gap-2">
            <SelectCheckbox item={item} />
            <Button
              variant="ghost"
              className="min-w-0 max-w-full justify-start whitespace-normal text-left wrap-anywhere"
              {...openProps(item.id)}
            >
              {titleOf(item)}
            </Button>
          </div>

          {/* Opens the view's one reschedule panel rather than a popover in the row: an edit that
              re-sorts the row moves its node, which would drop a panel living inside it. */}
          <button
            type="button"
            aria-label={`Edit dates: ${announce(placed)}`}
            aria-expanded={aside.rescheduling === item.id}
            aria-controls={aside.panelId}
            onClick={() => {
              aside.setRescheduling(aside.rescheduling === item.id ? null : item.id);
            }}
            className={cn(
              'flex min-h-(--control-md) w-fit max-w-full items-center rounded-md px-2 text-left pointer-coarse:min-h-(--control-lg)',
              focusRing,
            )}
          >
            <Text
              as="span"
              variant="caption"
              tone={placed.start === null || placed.end === null ? 'muted' : 'default'}
            >
              {datesLabel(placed, aside.endKey !== null)}
            </Text>
          </button>
        </li>
      )}
    </CalendarEntryMenu>
  );
}

function AgendaHeading({ text }: { readonly text: string }): ReactNode {
  return (
    <li className="mt-3 border-b border-divider pb-1 first:mt-0">
      <Text as="h3" variant="h6">
        {text}
      </Text>
    </li>
  );
}

/**
 * The phone's timeline: every dated item in date order under its day, then the unscheduled ones.
 * A bar chart does not fit 390px, and a window of it showed an empty screen when the items were
 * dated elsewhere, so the window is dropped here rather than squeezed. One flat list, so an item
 * keeps its place in the tree when an edit moves it to another day.
 */
export function TimelineAgenda({
  dated,
  undated,
  aside,
}: {
  readonly dated: readonly Placed[];
  readonly undated: readonly Placed[];
  readonly aside: AsideContext;
}): ReactNode {
  const sorted = dated.toSorted((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));
  const entries: ReactNode[] = [];
  let day: string | null = null;

  for (const placed of sorted) {
    if (placed.start !== day) {
      day = placed.start;
      entries.push(<AgendaHeading key={`day-${day ?? ''}`} text={spoken(day ?? '')} />);
    }
    entries.push(<AgendaRow key={placed.item.id} placed={placed} aside={aside} />);
  }

  if (undated.length > 0) {
    entries.push(<AgendaHeading key="unscheduled" text="Unscheduled" />);
    for (const placed of undated) {
      entries.push(<AgendaRow key={placed.item.id} placed={placed} aside={aside} />);
    }
  }

  return (
    <section aria-label="Timeline schedule">
      <ul className="flex flex-col">{entries}</ul>
    </section>
  );
}
