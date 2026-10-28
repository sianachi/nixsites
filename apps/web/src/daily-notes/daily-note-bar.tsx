import { Button, Dialog, Icon, Input, Text, focusRing } from '@nix/ui';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { useWorkspaceCalendar } from '../calendar/use-workspace-calendar';
import { writeStored } from '../lib/stored-setting';
import { browserStorage } from '../lib/browser-storage';
import { useMobileKeyboard } from '../layout/use-mobile-keyboard';
import { useNarrowViewport } from '../layout/viewport';
import { useOpenItem } from '../tabs/use-open-item';
import { readTimestampValue, readerZone } from '../views/core/timestamps';
import { useWorkspace } from '../workspaces/workspace-context';
import {
  dailyNoteLabel,
  localDailyNoteDate,
  parseDailyNoteDate,
  shiftDailyNoteDate,
} from './daily-note';
import { useDailyNoteSettings } from './use-daily-note-settings';

const SCHEDULE_OPEN_KEY = 'nix.daily-note.schedule-open';

function readScheduleOpen(): boolean {
  try {
    return browserStorage()?.getItem(SCHEDULE_OPEN_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * The strip above a daily note: which day it is, the way to the days around it, and what the
 * workspace calendar holds for it.
 *
 * Drawn from the note's own `$daily` marker by the page that hosts it, never from its title - the
 * title is whatever the workspace's format made it. Every move is a navigation to the daily
 * address, which opens or creates that day's note, so the bar holds no state about other days.
 * Absent while the workspace has daily notes switched off.
 */
export function DailyNoteBar({
  date,
  itemId,
}: {
  readonly date: string;
  readonly itemId: string;
}): ReactNode {
  const { workspaceId, workspace } = useWorkspace();
  const navigate = useNavigate();
  const settings = useDailyNoteSettings(workspaceId, workspace.canUseDailyNotes);
  const [scheduleOpen, setScheduleOpen] = useState(readScheduleOpen);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const narrow = useNarrowViewport();
  const keyboardVisible = useMobileKeyboard(narrow);

  // Every move the bar offers opens the daily address, which a workspace with daily notes switched
  // off refuses. The note itself stays an ordinary note; only the way between days goes.
  if (!workspace.canUseDailyNotes) return null;

  const today =
    settings.status === 'ready'
      ? localDailyNoteDate(new Date(), settings.settings.rolloverHour)
      : null;
  const previous = shiftDailyNoteDate(date, -1);
  const next = shiftDailyNoteDate(date, 1);

  function go(target: string | null): void {
    if (target !== null) {
      setNavigationOpen(false);
      void navigate(`/w/${workspaceId}/daily/${target}`);
    }
  }

  if (narrow) {
    return (
      <section
        aria-label="Daily note"
        hidden={keyboardVisible && !navigationOpen}
        className="shrink-0 border-b border-divider px-3 py-1"
      >
        <Button
          variant="ghost"
          className="min-w-0 w-full justify-between gap-2"
          aria-haspopup="dialog"
          aria-label={`Day navigation, ${dailyNoteLabel(date)}`}
          onClick={() => {
            setNavigationOpen(true);
          }}
        >
          <Text as="span" variant="bodySmall" className="min-w-0 truncate">
            {dailyNoteLabel(date)}
          </Text>
          <Icon icon={ChevronDown} size="sm" />
        </Button>
        {navigationOpen ? (
          <Dialog
            open
            title="Day navigation"
            onClose={() => {
              setNavigationOpen(false);
            }}
          >
            <div className="flex min-w-0 flex-col gap-4">
              <Input
                type="date"
                aria-label="Go to a day"
                className="min-w-0 max-w-full"
                value={date}
                onChange={(event) => {
                  go(parseDailyNoteDate(event.target.value));
                }}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button
                  variant="ghost"
                  aria-label="Previous day"
                  disabled={previous === null}
                  onClick={() => {
                    go(previous);
                  }}
                >
                  <Icon icon={ChevronLeft} size="sm" />
                  Previous
                </Button>
                <Button
                  variant="ghost"
                  disabled={today === null || today === date}
                  onClick={() => {
                    go(today);
                  }}
                >
                  Today
                </Button>
                <Button
                  variant="ghost"
                  aria-label="Next day"
                  disabled={next === null}
                  onClick={() => {
                    go(next);
                  }}
                >
                  Next
                  <Icon icon={ChevronRight} size="sm" />
                </Button>
              </div>
              <Text as="h2" variant="h3">
                Schedule
              </Text>
              <DaySchedule date={date} itemId={itemId} />
            </div>
          </Dialog>
        ) : null}
      </section>
    );
  }

  return (
    <section
      aria-label="Daily note"
      className="flex shrink-0 flex-col gap-1 border-b border-divider px-4 py-1.5 sm:px-8"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Text variant="note" as="p" className="font-medium">
          {dailyNoteLabel(date)}
        </Text>
        <div className="flex items-center gap-1">
          <Button
            variant="icon"
            aria-label="Previous day"
            disabled={previous === null}
            onClick={() => {
              go(previous);
            }}
          >
            <Icon icon={ChevronLeft} size="sm" />
          </Button>
          <Button
            variant="icon"
            aria-label="Next day"
            disabled={next === null}
            onClick={() => {
              go(next);
            }}
          >
            <Icon icon={ChevronRight} size="sm" />
          </Button>
          <Button
            variant="ghost"
            className="px-2 py-1 text-xs"
            disabled={today === null || today === date}
            onClick={() => {
              go(today);
            }}
          >
            Today
          </Button>
        </div>
        <Input
          type="date"
          aria-label="Go to a day"
          className="w-auto"
          value={date}
          onChange={(event) => {
            go(parseDailyNoteDate(event.target.value));
          }}
        />
        <Button
          variant="ghost"
          className="px-2 py-1 text-xs sm:ml-auto"
          aria-expanded={scheduleOpen}
          onClick={() => {
            // A device that will not remember is a device where the section starts closed; nothing to say.
            writeStored(SCHEDULE_OPEN_KEY, String(!scheduleOpen));
            setScheduleOpen(!scheduleOpen);
          }}
        >
          <Icon icon={ChevronDown} size="sm" className={scheduleOpen ? '' : '-rotate-90'} />
          {"That day's schedule"}
        </Button>
      </div>
      {scheduleOpen ? <DaySchedule date={date} itemId={itemId} /> : null}
    </section>
  );
}

/**
 * The calendar entries for one day. Mounted only while the section is open, so a closed bar costs
 * no request. The note itself is left out: it is on the screen already, and a daily note dated for
 * its own day would otherwise head its own list.
 */
function DaySchedule({
  date,
  itemId,
}: {
  readonly date: string;
  readonly itemId: string;
}): ReactNode {
  const { status, calendar, error, reload } = useWorkspaceCalendar(date, date);
  const { openPreview } = useOpenItem();

  if (status === 'loading') {
    return (
      <Text variant="caption" tone="muted" as="p" role="status">
        Loading the schedule...
      </Text>
    );
  }
  if (status === 'error' || calendar === null) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Text variant="caption" tone="muted" as="p" role="alert">
          {error ?? 'The schedule could not be loaded.'}
        </Text>
        <Button
          variant="ghost"
          className="px-2 py-0.5 text-xs"
          onClick={() => {
            void reload();
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

  // Placed by the day each value is written with, as the month grid does: a window the server
  // cuts coarsely can hand back an entry for a neighbouring day.
  const zone = readerZone();
  const entries = calendar.entries
    .filter((entry) => entry.itemId !== itemId && entry.value.slice(0, 10) === date)
    .map((entry) => {
      const moment =
        entry.kind === 'timestamp' ? readTimestampValue({ value: entry.value }, 'value') : null;
      return {
        entry,
        time: moment === null ? null : moment.at.setZone(zone).toFormat('HH:mm'),
      };
    })
    // Timed entries first and in clock order; entries with no time keep the server's order after.
    .sort((left, right) =>
      left.time === null || right.time === null
        ? Number(left.time === null) - Number(right.time === null)
        : left.time.localeCompare(right.time),
    );

  if (entries.length === 0 && !calendar.entriesTruncated) {
    return (
      <Text variant="caption" tone="muted" as="p">
        Nothing scheduled
      </Text>
    );
  }

  return (
    <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
      <ul className="flex flex-col gap-0.5">
        {entries.map(({ entry, time }) => (
          <li key={`${entry.itemId}:${entry.value}`}>
            <button
              type="button"
              className={`${focusRing} flex w-full items-baseline gap-2 rounded-sm px-1 py-0.5 text-left hover:bg-accent/10 pointer-coarse:min-h-(--control-lg)`}
              onClick={() => {
                openPreview(entry.itemId);
              }}
            >
              {time === null ? null : (
                <Text variant="caption" tone="muted" as="span">
                  {time}
                </Text>
              )}
              <Text variant="note" as="span" className="min-w-0 truncate">
                {entry.title === null || entry.title === '' ? 'Untitled' : entry.title}
              </Text>
            </button>
          </li>
        ))}
      </ul>
      {calendar.entriesTruncated ? (
        <Text variant="caption" tone="muted" as="p">
          More entries exist for this day than can be listed here.
        </Text>
      ) : null}
    </div>
  );
}
