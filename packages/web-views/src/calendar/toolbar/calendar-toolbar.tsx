import { Button, Icon, Text } from '@nix/ui';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  dayLabel,
  monthLabel,
  weekLabel,
  type CalendarDay,
  type CalendarMonth,
} from '@nix/web-collections/core/calendar-dates';
import { agendaDayLabel } from '@nix/web-collections/core/day-math';
import { CreateItemControl } from '../../core/create-item-control';

type Mode = 'month' | 'week' | 'day';

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

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Text variant="h6" as="h2" className="min-w-0 break-words">
        {mode === 'month'
          ? monthLabel(month)
          : mode === 'week'
            ? weekLabel(anchor)
            : dayLabel(anchor)}
      </Text>

      {/* aria-current rather than a tablist, following the view switcher: these are three ways of
            looking at one thing, and claiming to be tabs would owe arrow-key navigation nobody
            asked for. */}
      <nav aria-label="Calendar grain" className="flex items-center gap-0.5">
        {(['month', 'week', 'day'] as const).map((grain) => (
          <button
            key={grain}
            type="button"
            aria-current={mode === grain ? 'page' : undefined}
            onClick={() => {
              onMode(grain);
            }}
            className={[
              // The view tabs' height and radius, so the grain switcher lines up with them.
              'flex items-center rounded-md border px-2 py-1 text-sm capitalize min-h-(--control-md) pointer-coarse:min-h-(--control-lg)',
              'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
              mode === grain
                ? 'border-divider bg-foreground/7 text-foreground'
                : 'border-transparent text-muted hover:bg-foreground/5',
            ].join(' ')}
          >
            {grain}
          </button>
        ))}
      </nav>

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
          className="py-1"
          onClick={() => {
            onToday();
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
