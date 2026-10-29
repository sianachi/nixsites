import type {
  ChartOptions,
  PropertyDefinition,
  View,
} from '../../collections/core/container-model';
import { isDateShaped } from '../../collections/core/property-types';
import { chartKindOf, isChartPeriod, TIME_AXIS_KINDS, type ChartKind } from './chart-model';

/**
 * Keeping a chart view's options consistent with what it groups by, before it is saved.
 *
 * Core refuses a line, an area or a year grid without a period, and draws a chart with a period as
 * a time axis whatever it groups by. So whenever the grouping property or the type changes, the
 * draft is brought back to something Core will store and draw as shown: a date gets a period (a
 * month, unless one was chosen), a select loses its period, window and time-axis type, and a type
 * that cannot be split loses its split. Without this a person could pick "Due date" and save a
 * chart that counts one bar per distinct day.
 */

/** The options a chart with nothing configured has, as the parsed view carries them. */
export const EMPTY_CHART_OPTIONS: ChartOptions = {
  kind: null,
  period: null,
  splitBy: null,
  lastPeriods: null,
  from: null,
  to: null,
  cumulative: null,
  rollingAverage: null,
  stacked: null,
};

/** The types that draw one series only, so a split would be computed and never shown. */
const UNSPLIT_KINDS: ReadonlySet<ChartKind> = new Set(['pie', 'year']);

/** Whether a chart view groups by a date, and so has a time axis. */
export function groupsByDate(view: View, fields: readonly PropertyDefinition[]): boolean {
  const grouping = fields.find((field) => field.key === view.groupBy);
  return grouping !== undefined && isDateShaped(grouping.type);
}

/**
 * The chart types a view may offer given what it groups by and the period it counts in.
 *
 * No pie of days: a slice per day of a year is a pie nobody can read, and the shares of a run of
 * days are not a question anybody asks of one.
 */
export function offeredChartKinds(dated: boolean, period: string | null = null): ChartKind[] {
  return (['bar', 'column', 'pie', 'line', 'area', 'year'] as const).filter(
    (kind) =>
      (dated || !TIME_AXIS_KINDS.has(kind)) && !(kind === 'pie' && dated && period === 'day'),
  );
}

/**
 * The view with its chart options made consistent with its grouping and type.
 *
 * Returns a view whose `chart` is null when nothing beyond a bar chart of categories is configured,
 * so an untouched chart saves exactly as it did before options existed.
 */
export function normalizeChartView(view: View, fields: readonly PropertyDefinition[]): View {
  if (view.kind !== 'chart') {
    return view;
  }

  const current = view.chart ?? EMPTY_CHART_OPTIONS;
  const dated = groupsByDate(view, fields);
  let kind: ChartKind | null = current.kind === null ? null : chartKindOf(current.kind);

  let next: ChartOptions;
  if (dated) {
    const period =
      kind === 'year' ? 'day' : isChartPeriod(current.period) ? current.period : 'month';
    next = { ...current, kind, period };
  } else {
    if (kind !== null && TIME_AXIS_KINDS.has(kind)) {
      kind = null;
    }
    next = {
      ...current,
      kind,
      period: null,
      lastPeriods: null,
      from: null,
      to: null,
      cumulative: null,
      rollingAverage: null,
    };
  }

  if (kind === 'pie' && next.period === 'day') {
    next = { ...next, kind: null };
    kind = null;
  }
  if (kind !== null && UNSPLIT_KINDS.has(kind)) {
    next = { ...next, splitBy: null };
  }
  if ((kind !== 'column' && kind !== 'area') || next.splitBy === null) {
    next = { ...next, stacked: null };
  }
  if (kind !== 'line' && kind !== 'area') {
    next = { ...next, cumulative: null, rollingAverage: null };
  }
  if (next.lastPeriods !== null) {
    next = { ...next, from: null, to: null };
  }

  const empty = Object.values(next).every((value) => value === null || value === false);
  return { ...view, chart: empty ? null : next };
}
