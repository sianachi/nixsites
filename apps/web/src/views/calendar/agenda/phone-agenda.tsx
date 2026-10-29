import { Text } from '@nix/ui';
import type { ReactNode } from 'react';

import { dayText, weekOf, type CalendarDay } from '../../../collections/core/calendar-dates';
import type { Item } from '../../../collections/core/container-model';
import { CreateItemControl } from '../../core/create-item-control';
import type { CardContext } from '../item/card-context';
import { ItemCard } from '../item/item-card';
import { agendaDayLabel } from '../../../collections/core/day-math';

interface PhoneAgendaProps {
  readonly byDate: ReadonlyMap<string, readonly Item[]>;
  readonly mode: 'month' | 'week' | 'day';
  readonly prefix: string;
  readonly anchor: CalendarDay;
  readonly card: CardContext;

  /** A day chosen on the month strip: the agenda shows only it, empty or not. */
  readonly picked?: string | null;
}

/** What a phone opens on: the scheduled days of the window, one list per day. */
export function PhoneAgenda(props: PhoneAgendaProps): ReactNode {
  const { byDate, mode, prefix, anchor, card, picked = null } = props;

  const days: (readonly [string, readonly Item[]])[] =
    picked === null
      ? [...byDate]
          .filter(([date]) =>
            mode === 'month'
              ? date.startsWith(prefix)
              : (mode === 'week' ? weekOf(anchor) : [anchor]).some((day) => dayText(day) === date),
          )
          .sort(([a], [b]) => a.localeCompare(b))
      : [[picked, byDate.get(picked) ?? []]];

  return (
    <section aria-label="Calendar agenda" className="flex flex-col gap-4">
      {days.length === 0 ? (
        <Text as="p" variant="caption" tone="muted">
          Nothing scheduled here.
        </Text>
      ) : null}

      {days.map(([date, dated]) => (
        <section key={date} aria-label={agendaDayLabel(date)}>
          <Text as="h3" variant="h6">
            {agendaDayLabel(date)}
          </Text>
          {dated.length === 0 ? (
            <Text as="p" variant="caption" tone="muted">
              Nothing on this day.
            </Text>
          ) : (
            <ul className="flex flex-col gap-2">
              {dated.map((item) => (
                <li key={item.id}>
                  <ItemCard item={item} card={card} occurrenceDate={date} />
                </li>
              ))}
            </ul>
          )}

          {/* Always visible: a phone has no hover or tab walk to reveal a hidden control. */}
          <CreateItemControl
            label={`Add an item on ${agendaDayLabel(date)}`}
            properties={{ [card.dateProperty]: date }}
            onCreate={card.onCreate}
            className="mt-1 self-start"
          />
        </section>
      ))}
    </section>
  );
}
