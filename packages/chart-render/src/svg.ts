import {
  AVERAGE_SPAN,
  CHART_PERIOD_LABELS,
  MAXIMUM_SERIES,
  chartKindOf,
  countOf,
  formatMeasure,
  isChartPeriod,
  measureOf,
  plottedSeries,
  seriesPattern,
  trailingAverage,
  bucketLabel,
  type ChartLabels,
  type SeriesPattern,
} from './model.js';
import {
  CHART_HEIGHT,
  CHART_WIDTH,
  axisTickIndexes,
  columnGeometry,
  hatchPath,
  lineGeometry,
  pieGeometry,
  scaleTicks,
} from './geometry.js';
import type { ChartInput } from './types.js';

/**
 * A chart as a standalone SVG string plus the table of every figure, for a page with no React.
 *
 * **Styled by class, never by colour.** Marks carry `nix-chart-s<role>` classes (role 0 to 5 for
 * the series, 6 for "Other") and the host stylesheet maps them to the series tokens, so one SVG
 * follows the page's light or dark ground. Inline style attributes are avoided too: a site's
 * content security policy does not allow them.
 *
 * Like the app, the drawing is `aria-hidden` decoration over the table, which is what a screen
 * reader reads and where every figure lives as text.
 */

export interface ChartTable {
  readonly caption: string;
  readonly rowHeader: string;
  readonly columns: readonly string[];
  readonly rows: readonly { readonly label: string; readonly values: readonly string[] }[];
}

interface ChartLegendEntry {
  readonly label: string;
  /** A 12 by 12 swatch drawn the way the series is. */
  readonly swatch: string;
}

export interface RenderedChart {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
  readonly legend: readonly ChartLegendEntry[];
  readonly table: ChartTable;
  /** Sentences a reader needs beside the drawing, such as a folded series. */
  readonly notes: readonly string[];
}

export interface ChartRenderOptions {
  readonly labels: ChartLabels;
  /** Prefixes every id in the SVG, so several charts can share a page. */
  readonly idPrefix: string;
  /** Fixed for reproducible output; undefined means the runtime's locale. */
  readonly locale?: string;
  readonly caption: string;
}

const GUTTER = 44;
const TOP = 8;
const AXIS = 28;
const EVERY_LABEL = 6;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function num(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function patterns(prefix: string, styles: readonly SeriesPattern[]): string {
  return `<defs>${styles
    .map((style, index) => {
      const path = hatchPath(style.hatch);
      const hatch =
        path === null
          ? ''
          : `<path d="${path}" class="nix-chart-hatch" stroke-width="${style.hatch === 'dots' ? '3' : '1.5'}" stroke-linecap="round"/>`;
      return `<pattern id="${prefix}-${String(index)}" patternUnits="userSpaceOnUse" width="8" height="8"><rect width="8" height="8" class="nix-chart-s${String(style.role)}"/>${hatch}</pattern>`;
    })
    .join('')}</defs>`;
}

function swatch(prefix: string, style: SeriesPattern, line: boolean): string {
  if (line) {
    const dash = style.dash === undefined ? '' : ` stroke-dasharray="${style.dash}"`;
    return `<svg viewBox="0 0 24 8" width="24" height="8" aria-hidden="true"><line x1="2" x2="22" y1="4" y2="4" class="nix-chart-line-s${String(style.role)}" stroke-width="2" stroke-linecap="round"${dash}/></svg>`;
  }
  return `<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">${patterns(prefix, [style])}<rect width="12" height="12" rx="2" fill="url(#${prefix}-0)"/></svg>`;
}

function frame(input: {
  readonly body: string;
  readonly defs: string;
  readonly maximum: number;
  readonly whole: boolean;
  readonly labels: readonly string[];
}): { svg: string; width: number; height: number } {
  const width = GUTTER + CHART_WIDTH + 8;
  const height = TOP + CHART_HEIGHT + AXIS;
  const ticks = scaleTicks(input.maximum, input.whole)
    .map(
      (value, index) =>
        `<text x="${String(GUTTER - 8)}" y="${num(TOP + (index * CHART_HEIGHT) / 2 + 4)}" text-anchor="end" class="nix-chart-text">${escapeXml(formatMeasure(value))}</text>`,
    )
    .join('');
  const grid = [0, CHART_HEIGHT / 2, CHART_HEIGHT]
    .map(
      (y) =>
        `<line x1="0" x2="${String(CHART_WIDTH)}" y1="${String(y)}" y2="${String(y)}" class="nix-chart-grid" stroke-width="1"/>`,
    )
    .join('');
  const count = input.labels.length;
  const band = CHART_WIDTH / Math.max(1, count);
  // Up to EVERY_LABEL columns each carry their label, centred; more show the first, middle and
  // last. Labels are cut to fit at the largest size a page sets them (18 units, a glyph about 11
  // wide), so they never run into each other; the table under the chart has them whole.
  const every = count <= EVERY_LABEL;
  const room = Math.max(3, Math.floor((every ? band : CHART_WIDTH / 3) / 11));
  const fit = (label: string) =>
    label.length <= room ? label : `${label.slice(0, room - 1).trimEnd()}…`;
  const axis = (every ? input.labels.map((_, index) => index) : axisTickIndexes(count))
    .map((index, position, all) => {
      const anchor = every
        ? 'middle'
        : position === 0
          ? 'start'
          : position === all.length - 1
            ? 'end'
            : 'middle';
      const x = anchor === 'start' ? 0 : anchor === 'end' ? CHART_WIDTH : index * band + band / 2;
      return `<text x="${num(GUTTER + x)}" y="${String(TOP + CHART_HEIGHT + 20)}" text-anchor="${anchor}" class="nix-chart-text nix-chart-axis">${escapeXml(fit(input.labels[index] ?? ''))}</text>`;
    })
    .join('');
  return {
    width,
    height,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(width)} ${String(height)}" class="nix-chart" aria-hidden="true" focusable="false">${input.defs}${ticks}<g transform="translate(${String(GUTTER)},${String(TOP)})">${grid}${input.body}</g>${axis}</svg>`,
  };
}

/**
 * Draws a chart. Bars and the year grid draw as columns here: both are interactive tables in the
 * app, and on a static page the table below the drawing already carries every row.
 */
export function renderChartSvg(chart: ChartInput, options: ChartRenderOptions): RenderedChart {
  const { labels, idPrefix: prefix, locale } = options;
  const kind = chartKindOf(chart.chartKind);
  const lines = kind === 'line' || kind === 'area';
  const cumulative = lines && chart.cumulative;
  const split = chart.series.length > 0;
  const stacked = chart.stacked && split;
  const totals = chart.measure === 'sum';
  const notes: string[] = [];

  const averageAsked = lines && chart.rollingAverage;
  const averaged =
    averageAsked && !(kind === 'area' && stacked) && chart.buckets.length >= AVERAGE_SPAN;

  const rowHeader = isChartPeriod(chart.period)
    ? CHART_PERIOD_LABELS[chart.period]
    : labels.property(chart.groupBy);
  const rowLabels = chart.buckets.map((bucket) =>
    bucketLabel(bucket.value, chart.period, labels, chart.groupBy, false, locale),
  );
  const shortLabels = chart.buckets.map((bucket) =>
    bucketLabel(bucket.value, chart.period, labels, chart.groupBy, true, locale),
  );
  const series = plottedSeries(chart, labels, { cumulative }, seriesPattern);
  const averages = averaged ? series.map((entry) => trailingAverage(entry.values)) : undefined;
  const whole = !totals;

  if (chart.otherSeries > 0) {
    notes.push(
      `Only the ${String(MAXIMUM_SERIES)} largest values of "${labels.property(chart.splitBy)}" have their own series; the other ${String(chart.otherSeries)} share one series, Other.`,
    );
  }

  if (kind === 'pie') {
    const ranked = chart.buckets
      .map((bucket, index) => ({
        label: rowLabels[index] ?? '',
        value: measureOf(bucket, totals),
      }))
      .sort((first, second) => second.value - first.value);
    const named = ranked.slice(0, MAXIMUM_SERIES);
    const folded = ranked.slice(MAXIMUM_SERIES);
    const slices = [
      ...named.map((slice, index) => ({ ...slice, style: seriesPattern(index, false) })),
      ...(folded.length === 0
        ? []
        : [
            {
              label: `Other (${countOf(folded.length, 'value')})`,
              value: folded.reduce((sum, slice) => sum + slice.value, 0),
              style: seriesPattern(MAXIMUM_SERIES, true),
            },
          ]),
    ];
    const geometry = pieGeometry(slices.map((slice) => slice.value));
    const body =
      geometry.total === 0
        ? '<circle cx="0" cy="0" r="1" class="nix-chart-empty"/>'
        : geometry.slices
            .map((slice) => {
              const entry = slices[slice.index];
              const title = `<title>${escapeXml(`${entry?.label ?? ''}: ${formatMeasure(entry?.value ?? 0)} (${String(Math.round(slice.share * 100))}%)`)}</title>`;
              const fill = `url(#${prefix}-${String(slice.index)})`;
              return slice.d === null
                ? `<circle cx="0" cy="0" r="1" fill="${fill}">${title}</circle>`
                : `<path d="${slice.d}" fill="${fill}" class="nix-chart-separator" stroke-width="0.01">${title}</path>`;
            })
            .join('');
    const whole = ranked.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);
    return {
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1.05 -1.05 2.1 2.1" class="nix-chart nix-chart-pie" aria-hidden="true" focusable="false">${patterns(
        prefix,
        slices.map((slice) => slice.style),
      )}${body}</svg>`,
      width: 210,
      height: 210,
      legend: slices.map((slice, index) => ({
        label: slice.label,
        swatch: swatch(`${prefix}-l${String(index)}`, slice.style, false),
      })),
      table: {
        caption: options.caption,
        rowHeader,
        columns: [
          totals ? labels.property(chart.measureProperty) || 'Total' : 'Items',
          'Share (%)',
        ],
        rows: ranked.map((slice) => ({
          label: slice.label,
          values: [
            formatMeasure(slice.value),
            formatMeasure(
              whole === 0 ? 0 : Math.round((Math.max(0, slice.value) / whole) * 10000) / 100,
            ),
          ],
        })),
      },
      notes,
    };
  }

  const defs = patterns(
    prefix,
    series.map((entry) => entry.style),
  );
  let body: string;
  let maximum: number;
  if (lines) {
    const geometry = lineGeometry({
      series,
      count: chart.buckets.length,
      whole,
      area: kind === 'area',
      stacked,
      averages,
    });
    maximum = geometry.maximum;
    const areas = geometry.areas
      .map(
        (points, position) =>
          `<polygon points="${points}" fill="url(#${prefix}-${String(position)})"${geometry.stacking ? '' : ' class="nix-chart-translucent"'}/>`,
      )
      .join('');
    const paths = geometry.lines
      .map((d, position) => {
        const style = series[position]?.style ?? seriesPattern(0, false);
        const dash = style.dash === undefined ? '' : ` stroke-dasharray="${style.dash}"`;
        return `<path d="${d}" fill="none" class="nix-chart-line-s${String(style.role)}" stroke-width="2"${dash}/>`;
      })
      .join('');
    const dotted = geometry.averages
      .map((d, position) => {
        const style = series[position]?.style ?? seriesPattern(0, false);
        return `<path d="${d}" fill="none" class="nix-chart-line-s${String(style.role)}" stroke-dasharray="0 6" stroke-width="3" stroke-linecap="round"/>`;
      })
      .join('');
    const points = geometry.points
      .map((point) => {
        const entry = series[point.series];
        const role = entry?.style.role ?? 0;
        return `<circle cx="${num(point.cx)}" cy="${num(point.cy)}" r="3" class="nix-chart-s${String(role)}"><title>${escapeXml(`${rowLabels[point.bucket] ?? ''}, ${entry?.label ?? ''}: ${formatMeasure(entry?.values[point.bucket] ?? 0)}`)}</title></circle>`;
      })
      .join('');
    body = areas + paths + dotted + points;
  } else {
    const geometry = columnGeometry({ series, count: chart.buckets.length, whole, stacked });
    maximum = geometry.maximum;
    body = geometry.rects
      .map((rect) => {
        const entry = series[rect.series];
        const separator = geometry.separated ? ' class="nix-chart-separator" stroke-width="1"' : '';
        return `<rect x="${num(rect.x)}" y="${num(rect.y)}" width="${num(rect.width)}" height="${num(rect.height)}" fill="url(#${prefix}-${String(rect.series)})"${separator}><title>${escapeXml(`${rowLabels[rect.bucket] ?? ''}, ${entry?.label ?? ''}: ${formatMeasure(entry?.values[rect.bucket] ?? 0)}`)}</title></rect>`;
      })
      .join('');
  }

  const drawn = frame({ body, defs, maximum, whole, labels: shortLabels });
  const drawnLabel = (label: string) => (cumulative ? `${label} (running total)` : label);
  const columns = [
    ...series.map((entry) => ({ label: drawnLabel(entry.label), values: entry.values })),
    ...(averages ?? []).map((values, index) => ({
      label: `${drawnLabel(series[index]?.label ?? '')} (${String(AVERAGE_SPAN)}-period average)`,
      values,
    })),
    ...(split && !cumulative
      ? [{ label: 'All', values: chart.buckets.map((bucket) => measureOf(bucket, totals)) }]
      : []),
  ];

  return {
    ...drawn,
    legend:
      split || averages !== undefined
        ? series.map((entry, index) => ({
            label: entry.label,
            swatch: swatch(`${prefix}-l${String(index)}`, entry.style, lines),
          }))
        : [],
    table: {
      caption: options.caption,
      rowHeader,
      columns: columns.map((column) => column.label),
      rows: rowLabels.map((label, index) => ({
        label,
        values: columns.map((column) => formatMeasure(column.values[index] ?? null)),
      })),
    },
    notes,
  };
}
