import { Button, Icon, Segmented, Select, Text } from '@nix/ui';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useContext, type ReactNode } from 'react';
import { ZenPresentationContext } from '@nix/web-foundation/layout/zen-presentation';

import {
  dayLabel,
  monthLabel,
  weekLabel,
  type CalendarDay,
  type CalendarMonth,
} from '@nix/web-collections/core/calendar-dates';
import { agendaDayLabel } from '@nix/web-collections/core/day-math';
import { CreateItemControl } from '../../core/create-item-control';

const calendarModes = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
] as const;
type Mode = (typeof calendarModes)[number]['value'];

interface CalendarToolbarProps {
  readonly mode: Mode;
  readonly month: CalendarMonth;
  readonly anchor: CalendarDay;
  readonly onMode: (mode: Mode) => void;
  readonly onCreate: (
    title: string,
    properties?: Record<string, unknown>,
  ) => Promise<string | null>;
  /** The day the Add control puts the new item on, and the property that holds it. */
  readonly addDay: string;
  readonly dateProperty: string;
  readonly todayText: string;
  readonly onStep: (delta: number) => void;
  readonly onToday: () => void;
}

/** The heading, the month/week/day switch, the add control and the previous/today/next steps. */
export function CalendarToolbar(props: CalendarToolbarProps): ReactNode {
  const {
    mode,
    month,
    anchor,
    onMode,
    onCreate,
    addDay,
    dateProperty,
    todayText,
    onStep,
    onToday,
  } = props;
  const presentation = useContext(ZenPresentationContext);
  const alreadyToday =
    presentation?.collectionTools === false && mode === 'day' && addDay === todayText;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Text variant="h6" as="h2" className="min-w-0 break-words">
        {mode === 'month'
          ? monthLabel(month)
          : mode === 'week'
            ? weekLabel(anchor)
            : dayLabel(anchor)}
      </Text>

      {presentation?.collectionTools === false ? (
        <Select
          aria-label="Calendar period"
          className="w-auto"
          value={mode}
          onChange={(event) => {
            const chosen = calendarModes.find((grain) => grain.value === event.target.value);
            if (chosen !== undefined) onMode(chosen.value);
          }}
        >
          {calendarModes.map((grain) => (
            <option key={grain.value} value={grain.value}>
              {grain.label}
            </option>
          ))}
        </Select>
      ) : (
        <Segmented label="Calendar period" options={calendarModes} value={mode} onChange={onMode} />
      )}

      {/* Always visible, never gated behind a hover, and dated: it says which day it adds to and
            writes that day, so adding to a day is one tap and a name on every width. */}
      <CreateItemControl
        label={`Add to ${addDay === todayText ? 'today' : agendaDayLabel(addDay)}`}
        properties={{ [dateProperty]: addDay }}
        onCreate={onCreate}
        className="pointer-coarse:min-h-(--control-lg)"
      />

      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="subtle"
          aria-label={`Previous ${mode}`}
          className="px-2"
          onClick={() => {
            onStep(-1);
          }}
        >
          <Icon icon={ChevronLeft} size="sm" />
        </Button>

        <Button
          variant="secondary"
          className="py-1 aria-disabled:opacity-45"
          aria-disabled={alreadyToday || undefined}
          onClick={() => {
            if (!alreadyToday) onToday();
          }}
        >
          Today
        </Button>

        <Button
          variant="subtle"
          aria-label={`Next ${mode}`}
          className="px-2"
          onClick={() => {
            onStep(1);
          }}
        >
          <Icon icon={ChevronRight} size="sm" />
        </Button>
      </div>
    </div>
  );
}
