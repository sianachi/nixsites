import { Button, Text } from '@nix/ui';
import { useId, useState, type ReactNode } from 'react';

import { CalendarEntryMenu } from '../calendar/calendar-entry-menu';
import { SelectCheckbox } from '../core/select-checkbox';
import { RescheduleToggle } from './timeline-reschedule';
import type { AsideContext, Placed } from './timeline-model';
import { titleOf } from './timeline-model';
import { announce, describeDates } from './timeline-text';
import { useTimelineOpenProps } from './use-timeline-open-props';

const MAXIMUM_COLLAPSED_OFF_AXIS_ITEMS = 20;

export interface OffAxisListProps {
  readonly heading: string;
  readonly detail: string;
  readonly placed: readonly Placed[];
  readonly aside: AsideContext;
  readonly showWhenEmpty?: boolean;
  readonly empty?: string;
}

/**
 * The items the axis cannot draw, listed rather than dropped.
 *
 * One component for all four bands because they differ only in their sentence: the affordances an
 * item needs - open it, and correct its dates - are the same whether it is undated, unreadable,
 * contradictory, or merely off-screen.
 */
export function OffAxisList({
  heading,
  detail,
  placed,
  aside,
  showWhenEmpty = false,
  empty,
}: OffAxisListProps): ReactNode {
  const headingId = useId();
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? placed : placed.slice(0, MAXIMUM_COLLAPSED_OFF_AXIS_ITEMS);
  const hidden = placed.length - visible.length;

  if (placed.length === 0 && !showWhenEmpty) {
    return null;
  }

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-md border border-divider p-3"
    >
      <Text variant="h6" as="h3" id={headingId}>
        {heading}
      </Text>

      <Text variant="caption" tone="muted">
        {placed.length === 0 ? (empty ?? detail) : detail}
      </Text>

      {placed.length === 0 ? null : (
        <ul className="flex flex-col gap-2">
          {visible.map((entry) => (
            <OffAxisEntry key={entry.item.id} placed={entry} aside={aside} />
          ))}
        </ul>
      )}

      {placed.length <= MAXIMUM_COLLAPSED_OFF_AXIS_ITEMS ? null : (
        <Button
          variant="subtle"
          className="self-start py-1 text-sm"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((current) => !current);
          }}
        >
          {expanded ? 'Show fewer' : `Show ${String(hidden)} more`}
        </Button>
      )}
    </section>
  );
}

function OffAxisEntry({
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
        <li {...contextTarget} className="group flex min-w-0 flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <SelectCheckbox item={item} />
            {/* `before:-inset-x-0.5`: the control keeps `<Button>`'s 36px height, but with `px-0` its
            width is its text's, and a one- or two-character title lands under WCAG 2.5.8's 24px
            floor - the same widening as the calendar card's title, half a step each side so it
            never reaches the reschedule toggle beside it. */}
            <Button
              variant="subtle"
              aria-label={announce(placed)}
              className="relative min-w-0 flex-1 justify-start px-0 py-0.5 text-left text-sm before:absolute before:inset-y-0 before:-inset-x-0.5"
              {...openProps(item.id)}
            >
              <span className="truncate">{titleOf(item)}</span>
            </Button>

            <RescheduleToggle item={item} aside={aside} />
          </div>

          {/* Both dates in front of somebody, always. For a reversed pair especially: the whole reason
          this band exists is that the contradiction is worth seeing rather than being corrected
          away, and a list that named neither date would be hiding it a second time. */}
          <Text variant="caption" tone="muted">
            {describeDates(placed)}
          </Text>
        </li>
      )}
    </CalendarEntryMenu>
  );
}
