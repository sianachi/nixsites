import type { MirrorItem } from '@nix/sync-core/mirror';

import { formatDay, parseDay } from '../recurrence/days';
import { mergeOccurrences, type Series } from '../recurrence/expand';
import { readRule } from '../recurrence/rule';
import type { ViewAnswer, ViewCompute } from '../types';

// Core's GetWorkspaceCalendarHandler ceilings.
const MAXIMUM_ENTRIES = 2_000;
const MAXIMUM_WINDOW_DAYS = 400;
const MAXIMUM_RECURRING_ITEMS = 500;
const DUE_DATE = 'due_date';
const DAILY_DAY = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;

interface Entry {
  readonly itemId: string;
  readonly title: string | null;
  readonly containerId: string;
  readonly containerTitle: string | null;
  readonly dateProperty: string;
  readonly value: string;
  readonly kind: 'date' | 'timestamp';
  readonly generated: boolean;
  readonly completed: boolean | null;
  readonly endProperty: string | null;
  readonly endValue: string | null;
}

interface Unplaceable {
  readonly containerId: string;
  readonly containerTitle: string | null;
  readonly reason: string;
  readonly itemId: string | null;
  readonly itemTitle: string | null;
}

const invalidWindow = (detail: string): ViewAnswer => ({
  status: 400,
  code: 'calendar.invalid_window',
  detail,
});

/** Postgres `jsonb ->> key`: the text of a scalar, null for absent, JSON null or a container. */
const text = (value: unknown): string | null =>
  typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : null;

const bag = (item: MirrorItem): Record<string, unknown> => item.properties;
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The calendar view a container places by: the first `calendar` entry, as the array stores it. */
function calendarView(item: MirrorItem): Record<string, unknown> | null {
  const views = item.views?.views;
  if (!Array.isArray(views)) return null;
  const found = (views as unknown[]).find(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { kind?: unknown }).kind === 'calendar',
  );
  return (found ?? null) as Record<string, unknown> | null;
}

export const computeCalendar: ViewCompute = async (source, request, match) => {
  const from = request.url.searchParams.get('from');
  const to = request.url.searchParams.get('to');
  if (from === null || from === '' || to === null || to === '')
    return invalidWindow("Both 'from' and 'to' are required, as yyyy-MM-dd.");

  const first = parseDay(from);
  if (first === null)
    return invalidWindow(`'${from}' is not a date. Windows are given as yyyy-MM-dd.`);
  const last = parseDay(to);
  if (last === null)
    return invalidWindow(`'${to}' is not a date. Windows are given as yyyy-MM-dd.`);
  if (last < first) return invalidWindow(`The window ends (${to}) before it begins (${from}).`);
  if (last - first + 1 > MAXIMUM_WINDOW_DAYS)
    return invalidWindow(
      `The window covers ${String(last - first + 1)} days, and the most one read may cover is ${String(MAXIMUM_WINDOW_DAYS)}.`,
    );

  const workspaceId = match[1] ?? '';
  const items = (await source.workspaceItems(workspaceId)).filter(
    (item) => item.lifecycleState === 'active',
  );
  // A readable workspace always holds items; none means we cannot tell "empty" from "not synced".
  if (items.length === 0) return null;

  const children = new Map<string, MirrorItem[]>();
  for (const item of items)
    if (item.parentId !== null)
      children.set(item.parentId, [...(children.get(item.parentId) ?? []), item]);

  // A lock's withheld metadata (views, recurrence) cannot be told from "none"; never guess.
  if (items.some((item) => item.locked && children.has(item.id))) return null;

  // The daily-notes arm needs the workspace's showOnCalendar/enabled settings, not in the mirror.
  if (
    items.some((item) => {
      const day = text(bag(item).$daily);
      return day !== null && DAILY_DAY.test(day) && day >= from && day <= to;
    })
  )
    return null;

  const chosen = items.flatMap((container) => {
    const view = calendarView(container);
    return view === null || container.locked
      ? []
      : [
          {
            container,
            dateProperty: text(view.dateProperty),
            endProperty: text(view.endDateProperty),
          },
        ];
  });

  const unplaceableContainers: Unplaceable[] = chosen
    .filter((entry) => entry.dateProperty === null)
    .map(({ container }) => ({
      containerId: container.id,
      containerTitle: container.title,
      reason: 'no_date_property',
      itemId: null,
      itemTitle: null,
    }));

  const dated = chosen.flatMap((entry) =>
    entry.dateProperty === null ? [] : [{ ...entry, dateProperty: entry.dateProperty }],
  );
  // A locked child hides its own recurrence rule, which Core still reads.
  if (
    dated.some(
      ({ container }) => children.get(container.id)?.some((child) => child.locked) === true,
    )
  )
    return null;

  // Concrete entries: the earliest MAXIMUM_ENTRIES by (value, seq, id), then listed by (value, id).
  const concrete = dated
    .flatMap(({ container, dateProperty, endProperty }) =>
      (children.get(container.id) ?? []).flatMap((child) => {
        const value = text(bag(child)[dateProperty]);
        const day = value?.slice(0, 10);
        return value === null || day === undefined || day < from || day > to
          ? []
          : [
              {
                child,
                entry: {
                  itemId: child.id,
                  title: child.title,
                  containerId: container.id,
                  containerTitle: container.title,
                  dateProperty,
                  value,
                  kind: value.length === 10 ? 'date' : 'timestamp',
                  generated: false,
                  completed: null,
                  endProperty,
                  endValue: endProperty === null ? null : text(bag(child)[endProperty]),
                } satisfies Entry,
              },
            ];
      }),
    )
    .sort(
      (a, b) =>
        order(a.entry.value, b.entry.value) ||
        Number(BigInt(a.child.seq) - BigInt(b.child.seq)) ||
        order(a.child.id, b.child.id),
    )
    .slice(0, MAXIMUM_ENTRIES)
    .map(({ entry }) => entry)
    .sort((a, b) => order(a.value, b.value) || order(a.itemId, b.itemId));

  // Recurring candidates: the container's chosen property, the item's own rule and due date.
  const candidates = dated
    .flatMap(({ container, dateProperty }) =>
      (children.get(container.id) ?? [])
        .filter((child) => {
          if (child.recurrence === null) return false;
          const dueDay = text(bag(child).due_date)?.slice(0, 10) ?? null;
          const until = text(child.recurrence.until);
          return (dueDay === null || dueDay <= to) && (until === null || until >= from);
        })
        .map((child) => ({ container, dateProperty, child })),
    )
    .sort(
      (a, b) => Number(BigInt(a.child.seq) - BigInt(b.child.seq)) || order(a.child.id, b.child.id),
    )
    .slice(0, MAXIMUM_RECURRING_ITEMS);

  const drawable: Series<(typeof candidates)[number]>[] = [];
  const unplaceableCandidates: Unplaceable[] = [];
  for (const candidate of candidates) {
    const anchor = parseDay(text(bag(candidate.child).due_date)?.slice(0, 10));
    const rule = readRule(candidate.child.recurrence);
    const reason =
      candidate.dateProperty !== DUE_DATE
        ? 'calendar_not_by_due_date'
        : anchor === null
          ? 'no_due_date'
          : rule === null
            ? 'unreadable_rule'
            : null;
    if (reason !== null || anchor === null || rule === null)
      unplaceableCandidates.push({
        containerId: candidate.container.id,
        containerTitle: candidate.container.title,
        reason: reason ?? 'unreadable_rule',
        itemId: candidate.child.id,
        itemTitle: candidate.child.title,
      });
    else drawable.push({ owner: candidate, rule, anchor });
  }

  const merge = mergeOccurrences(
    drawable,
    first,
    last,
    Math.max(0, MAXIMUM_ENTRIES - concrete.length),
  );

  // Both lists are sorted by value; ties keep the stored entry first.
  const rows: Entry[] = [];
  let next = 0;
  for (const occurrence of merge.occurrences) {
    const value = formatDay(occurrence.day);
    while (next < concrete.length && order((concrete[next] as Entry).value, value) <= 0)
      rows.push(concrete[next++] as Entry);
    const { child, container, dateProperty } = occurrence.owner;
    rows.push({
      itemId: child.id,
      title: child.title,
      containerId: container.id,
      containerTitle: container.title,
      dateProperty,
      value,
      kind: 'date',
      generated: true,
      completed: occurrence.completed,
      endProperty: null,
      endValue: null,
    });
  }
  rows.push(...concrete.slice(next));

  return {
    status: 200,
    body: {
      workspaceId,
      from,
      to,
      entries: rows,
      unplaceable: [...unplaceableContainers, ...unplaceableCandidates],
      entryLimit: MAXIMUM_ENTRIES,
      entriesTruncated: rows.length >= MAXIMUM_ENTRIES,
      seriesTruncated: candidates.length >= MAXIMUM_RECURRING_ITEMS || merge.truncated,
    },
  };
};
