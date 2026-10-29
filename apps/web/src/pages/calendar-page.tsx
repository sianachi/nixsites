import { useHiddenItems } from '@nix/web-collections/items/use-hidden-items';
import { publishNotice } from '@nix/web-foundation/lib/notices';
import { useItemDialog } from '@nix/web-foundation/lib/item-dialog-context';
import { Button, Text } from '@nix/ui';
import { useState, type ReactElement, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';

import { anchorOf, anchorText, grainOf, windowFor } from '../calendar/calendar-window';
import { CollatedCalendar } from '../calendar/collated-calendar';
import {
  filterByNotes,
  isDailyNote,
  noteOptions,
  notesParam,
  parseNotes,
  unplaceableEntryCount,
} from '../calendar/collated-entries';
import { NoteFilter } from '../calendar/note-filter';
import { useWorkspaceCalendar } from '../calendar/use-workspace-calendar';
import {
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
  PartialNotice,
} from '@nix/web-foundation/components/states/status-panels';
import { paneScroller } from '@nix/web-foundation/layout/regions';
import { useOpenItem } from '../tabs/use-open-item';
import type { CalendarDay } from '@nix/web-collections/core/calendar-dates';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';

/**
 * The calendar destination: every calendar in the workspace, drawn as one.
 *
 * A date set in one container used to be invisible from every other. This collates them, so a date
 * is a date wherever it was set - which is only true because the server resolves each container's
 * own date property rather than the client guessing one for the workspace.
 *
 * **Three things it admits to, and none of them are decoration.** The entry ceiling, because a
 * truncated list looks short and announces itself while a truncated calendar looks like a calendar.
 * Containers that offer a calendar and name no property, because a reader who cannot tell "nothing
 * is scheduled" from "that one could not be read" will believe the first. And entries whose stored
 * value this build cannot place, counted rather than dropped.
 *
 * Opening an item goes through the same `useOpenItem` the tree and the palette use, so an item
 * opened from here lands in the pane a reader expects. The calendar does not own a second idea of
 * what is open.
 */

/**
 * The destination's frame: its heading, and whatever state it is in.
 *
 * The heading is outside the state fork on purpose. It answers "where am I", which is true while
 * the calendar is loading, true when it failed, and true when the workspace has nothing scheduled -
 * and a destination that only names itself once it has data leaves a reader on an untitled page in
 * exactly the moments they most need to know where they landed.
 */
function CalendarFrame({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <div className={`${paneScroller} flex min-w-0 flex-col gap-3 p-3 sm:p-4`}>
      <Text variant="h4" as="h1">
        Calendar
      </Text>
      {children}
    </div>
  );
}

/** Today, read once per mount rather than per render. */
function todayHere(): CalendarDay {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth(), day: now.getDate() };
}

export function CalendarPage(): ReactElement {
  const visibility = useHiddenItems();
  const { workspace } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const { openPreview } = useOpenItem();
  const openDialog = useItemDialog();

  // Read once and held, so a page left open overnight does not silently change what "today" means
  // underneath a reader who is looking at last month.
  const [today] = useState(todayHere);

  const grain = grainOf(params.get('grain'));
  const anchor = anchorOf(params.get('on'), today);
  const window = windowFor(grain, anchor);

  const {
    status,
    calendar,
    error,
    reload,
    reschedule,
    write: writeEntry,
    addEndTimes,
    create,
    complete,
  } = useWorkspaceCalendar(window.from, window.to);

  // Both replace rather than push: moving through a calendar is not a navigation, and a reader who
  // stepped through six weeks should not have to press Back six times to leave.
  const write = (next: { grain?: string; on?: string; notes?: string }): void => {
    const updated = new URLSearchParams(params);
    if (next.grain !== undefined) {
      updated.set('grain', next.grain);
    }
    if (next.on !== undefined) {
      updated.set('on', next.on);
    }
    if (next.notes !== undefined) {
      // Removed rather than set empty, so "every note" is spelled as absence. Two spellings of one
      // state would leave a later reader unable to tell "never filtered" from "filtered to all".
      if (next.notes.length === 0) {
        updated.delete('notes');
      } else {
        updated.set('notes', next.notes);
      }
    }
    setParams(updated, { replace: true });
  };

  if (status === 'loading') {
    return (
      <CalendarFrame>
        <LoadingPanel label="the workspace calendar" />
      </CalendarFrame>
    );
  }

  if (status === 'error' || calendar === null) {
    return (
      <CalendarFrame>
        <ErrorPanel
          title="The calendar could not be loaded"
          detail={error ?? 'Something went wrong reading this workspace.'}
          action={
            <Button
              onClick={() => {
                void reload();
              }}
            >
              Try again
            </Button>
          }
        />
      </CalendarFrame>
    );
  }

  const notes = parseNotes(params.get('notes'));
  // Daily notes are left off while the workspace has them switched off, whatever the read sent:
  // their chips open the day's note, which such a workspace no longer offers.
  const listed = workspace.canUseDailyNotes
    ? calendar.entries
    : calendar.entries.filter((entry) => !isDailyNote(entry));
  const visible = listed.filter((entry) => !visibility.hiddenSet.has(entry.itemId));
  const unplaceable = calendar.unplaceable.filter(
    (row) => !visibility.hiddenSet.has(row.itemId ?? row.containerId),
  );
  const unplaceableEntries = unplaceableEntryCount({ ...calendar, entries: visible });
  const unplaceableNotices = describeUnplaceable(unplaceable);
  const options = noteOptions(visible);
  const shown = filterByNotes(visible, notes);

  return (
    <CalendarFrame>
      {calendar.entriesTruncated && (
        <PartialNotice
          pending={`Showing the first ${String(calendar.entryLimit)} items in this range. Some dated items are not drawn.`}
        />
      )}

      {unplaceableNotices.map((notice) => (
        <PartialNotice key={notice.reason} pending={notice.text} />
      ))}

      {unplaceableEntries > 0 && (
        <PartialNotice
          pending={`${String(unplaceableEntries)} ${unplaceableEntries === 1 ? 'item carries a date' : 'items carry dates'} this version cannot read, so ${unplaceableEntries === 1 ? 'it is' : 'they are'} not drawn.`}
        />
      )}

      {visible.length < listed.length || unplaceable.length < calendar.unplaceable.length ? (
        <Text role="status" variant="caption" tone="muted">
          Hidden items excluded
        </Text>
      ) : null}
      {listed.length === 0 && calendar.unplaceable.length === 0 ? (
        <EmptyPanel
          title="Nothing scheduled"
          detail="No item in this workspace carries a date in this range. Give a note a calendar view and a date property, and it will appear here."
        />
      ) : (
        <NoteFilter
          options={options}
          selected={notes}
          onChange={(next) => {
            write({ notes: notesParam(next) });
          }}
        />
      )}

      <CollatedCalendar
        entries={shown}
        grain={grain}
        onGrain={(next) => {
          write({ grain: next });
        }}
        anchor={anchor}
        onAnchor={(next) => {
          write({ on: anchorText(next) });
        }}
        today={today}
        onOpen={openDialog ?? openPreview}
        onReschedule={(entry, value) => {
          void reschedule(entry.itemId, entry.dateProperty, value);
        }}
        onWrite={(entry, values) => {
          void writeEntry(entry.itemId, values);
        }}
        onAddEndTimes={(entry) => {
          void addEndTimes(entry.containerId).then((refusal) => {
            publishNotice({
              key: `calendar-end:${entry.containerId}`,
              message:
                refusal ??
                `"${entry.containerTitle ?? 'Untitled'}" now has end times. Drag the foot of one of its items, or use Reschedule, to set how long it runs.`,
            });
          });
        }}
        onCreate={create}
        onComplete={(entry, occurredOn) => {
          void complete(entry.itemId, occurredOn);
        }}
      />
    </CalendarFrame>
  );
}

/**
 * What the calendar could not draw, said one reason at a time.
 *
 * Four reasons reach this list and they are not the same fact: a container that never named a date
 * property is a setup somebody has to finish, while a repeating item that cannot be placed is a
 * different problem with a different fix. Collapsing them into one sentence - which this page did
 * while only the first reason existed - would tell three quarters of readers something untrue about
 * their own workspace.
 */
function describeUnplaceable(
  rows: readonly {
    readonly containerTitle: string | null;
    readonly itemTitle?: string | null;
    readonly reason: string;
  }[],
): readonly { readonly reason: string; readonly text: string }[] {
  const byReason = new Map<string, string[]>();
  for (const row of rows) {
    const named = row.itemTitle ?? row.containerTitle ?? 'Untitled';
    byReason.set(row.reason, [...(byReason.get(row.reason) ?? []), named]);
  }

  return [...byReason.entries()].map(([reason, names]) => ({
    reason,
    text: `${names.join(', ')} ${sentenceFor(reason, names.length === 1)}`,
  }));
}

/** The sentence for one reason, in the number the list needs. */
function sentenceFor(reason: string, singular: boolean): string {
  switch (reason) {
    case 'calendar_not_by_due_date':
      return singular
        ? 'repeats, but this calendar places by another property, so its occurrences are not drawn.'
        : 'repeat, but this calendar places by another property, so their occurrences are not drawn.';
    case 'no_due_date':
      return singular
        ? 'repeats but has no due date to repeat from, so nothing is drawn for it.'
        : 'repeat but have no due date to repeat from, so nothing is drawn for them.';
    case 'unreadable_rule':
      return singular
        ? 'carries a repeating rule this version cannot read, so it is not drawn.'
        : 'carry repeating rules this version cannot read, so they are not drawn.';
    default:
      return singular
        ? 'offers a calendar but names no date property, so nothing from it is drawn.'
        : 'offer calendars but name no date property, so nothing from them is drawn.';
  }
}
