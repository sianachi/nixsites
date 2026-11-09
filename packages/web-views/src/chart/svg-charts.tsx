import {
  CHART_HEIGHT as HEIGHT,
  CHART_WIDTH as WIDTH,
  axisTickIndexes,
  columnGeometry,
  hatchPath,
  lineGeometry,
  pieGeometry,
  scaleTicks,
} from '@nix/chart-render';
import { Text, cn } from '@nix/ui';
import { useId, type ReactNode } from 'react';

import { formatMeasure, type PlottedSeries, type SeriesStyle } from './chart-model';
import type { ChartPicking } from './chart-selection';

/**
 * The drawn chart types: columns, lines and areas, and a pie.
 *
 * **Every drawing here is `aria-hidden` decoration over a table.** The figures are text in the
 * `ChartTable` the chart view renders beside each of these, which is what a screen reader reads and
 * what a copy carries. A hover `<title>` on each mark is a convenience for a pointer, not the only
 * place a value can be found.
 *
 * **Geometry in a fixed coordinate space, stretched to the container.** Each SVG draws in a 600 by
 * 200 box with `preserveAspectRatio="none"` and non-scaling strokes - the same approach the habit
 * trend takes - so it fills a phone or a wide pane without a resize observer. Axis labels are HTML
 * around the drawing, so text is never stretched with it. The pie keeps its aspect ratio; a
 * stretched circle would misstate every share.
 *
 * **Negative totals are drawn from zero up as nothing.** A sum can be negative; a column or a slice
 * cannot be. The table still carries the figure, signed.
 *
 * Where each mark goes is computed by `@nix/chart-render`'s geometry, which a published site draws
 * from too; this file only turns those shapes into JSX.
 */

/** One `<pattern>` per style, so fills are told apart by hatch as well as by tone. */
function SeriesPatterns({
  prefix,
  styles,
}: {
  readonly prefix: string;
  readonly styles: readonly SeriesStyle[];
}): ReactNode {
  return (
    <defs>
      {styles.map((style, index) => {
        const path = hatchPath(style.hatch);
        return (
          <pattern
            key={index}
            id={`${prefix}-${String(index)}`}
            patternUnits="userSpaceOnUse"
            width="8"
            height="8"
          >
            <rect width="8" height="8" className={style.fill} />
            {path === null ? null : (
              <path
                d={path}
                className="stroke-background"
                strokeWidth={style.hatch === 'dots' ? 3 : 1.5}
                strokeLinecap="round"
              />
            )}
          </pattern>
        );
      })}
    </defs>
  );
}

function patternFill(prefix: string, index: number): string {
  return `url(#${prefix}-${String(index)})`;
}

function Frame({
  maximum,
  whole,
  labels,
  shortLabels,
  children,
}: {
  readonly maximum: number;
  readonly whole: boolean;
  readonly labels: readonly string[];
  readonly shortLabels: readonly string[];
  readonly children: ReactNode;
}): ReactNode {
  const shown = axisTickIndexes(labels.length);

  return (
    <div className="flex gap-2" aria-hidden="true">
      <div className="flex h-48 w-10 shrink-0 flex-col justify-between text-right">
        {scaleTicks(maximum, whole).map((value, index) => (
          <Text key={index} variant="caption" tone="muted">
            {formatMeasure(value)}
          </Text>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        {children}
        <div className="mt-1 flex justify-between gap-2">
          {shown.map((index) => (
            <Text key={index} variant="caption" tone="muted" className="truncate">
              <span className="hidden sm:inline">{labels[index] ?? ''}</span>
              <span className="sm:hidden">{shortLabels[index] ?? labels[index] ?? ''}</span>
            </Text>
          ))}
        </div>
      </div>
    </div>
  );
}

function Gridlines(): ReactNode {
  return (
    <>
      {[0, HEIGHT / 2, HEIGHT].map((y) => (
        <line
          key={y}
          x1="0"
          x2={WIDTH}
          y1={y}
          y2={y}
          className="stroke-divider"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </>
  );
}

/**
 * A full-height strip over one bucket: the target a finger can hit, since a bar of three items is a
 * sliver. Picking it picks the whole bucket; a mark inside picks its series. Pointer-only by design:
 * the keyboard path is the table's buttons, which say the same figures.
 */
function Band({
  keys,
  x,
  width,
  picking,
}: {
  readonly keys: readonly string[];
  readonly x: number;
  readonly width: number;
  readonly picking: ChartPicking;
}): ReactNode {
  return (
    <rect
      x={x}
      y={0}
      width={width}
      height={HEIGHT}
      onClick={() => {
        picking.toggle(keys);
      }}
      className={cn(
        'cursor-pointer',
        picking.isOn(keys) ? 'fill-accent/15' : 'fill-transparent hover:fill-accent/10',
      )}
    />
  );
}

interface AxisProps {
  /** The bucket keys, aligned with `labels`, which a pick is made of. */
  readonly keys?: readonly string[] | undefined;
  /** Present when the marks can be picked to list the items behind them. */
  readonly picking?: ChartPicking | undefined;
  /** One label per bucket, of which the frame shows the first, middle and last. */
  readonly labels: readonly string[];
  /** The same labels shortened for a phone. */
  readonly shortLabels: readonly string[];
  /** Whether the values are counts, so the scale ticks whole numbers. */
  readonly whole: boolean;
}

export interface ColumnChartProps extends AxisProps {
  readonly series: readonly PlottedSeries[];
  /** Stack the series in one column per bucket, or stand them side by side. */
  readonly stacked: boolean;
}

/** Vertical columns, one per bucket; stacked or side by side when the chart is split. */
export function ColumnChart({
  series,
  labels,
  shortLabels,
  whole,
  stacked,
  keys = [],
  picking,
}: ColumnChartProps): ReactNode {
  const prefix = useId().replaceAll(':', '');
  const geometry = columnGeometry({ series, count: labels.length, whole, stacked });

  return (
    <Frame maximum={geometry.maximum} whole={whole} labels={labels} shortLabels={shortLabels}>
      <svg
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        preserveAspectRatio="none"
        className="h-48 w-full overflow-visible"
      >
        <SeriesPatterns prefix={prefix} styles={series.map((entry) => entry.style)} />
        <Gridlines />
        {picking === undefined
          ? null
          : keys.map((key, index) => (
              <Band
                key={key}
                keys={[key]}
                x={(index * WIDTH) / Math.max(1, labels.length)}
                width={WIDTH / Math.max(1, labels.length)}
                picking={picking}
              />
            ))}
        {labels.map((label, index) => (
          <g key={`${label}-${String(index)}`}>
            {geometry.rects
              .filter((rect) => rect.bucket === index)
              .map((rect) => {
                const entry = series[rect.series];
                const key = keys[index] ?? '';
                const split = series.length > 1;
                const picked = picking?.isOn([key], split ? rect.series : undefined) === true;
                return entry === undefined ? null : (
                  <rect
                    key={entry.key}
                    x={rect.x}
                    y={rect.y}
                    width={rect.width}
                    height={rect.height}
                    fill={patternFill(prefix, rect.series)}
                    className={cn(
                      geometry.separated ? 'stroke-background' : undefined,
                      picking !== undefined && 'cursor-pointer hover:opacity-80 active:opacity-65',
                      picked && 'stroke-foreground',
                    )}
                    strokeWidth={picked ? 2.5 : geometry.separated ? 1 : 0}
                    vectorEffect="non-scaling-stroke"
                    onClick={
                      picking === undefined
                        ? undefined
                        : () => {
                            picking.toggle([key], split ? rect.series : undefined);
                          }
                    }
                  >
                    <title>{`${label}, ${entry.label}: ${formatMeasure(entry.values[index] ?? 0)}`}</title>
                  </rect>
                );
              })}
          </g>
        ))}
      </svg>
    </Frame>
  );
}

export interface LineChartProps extends AxisProps {
  readonly series: readonly PlottedSeries[];
  /** Fill under each line. */
  readonly area: boolean;
  /** For areas split into series: stack them rather than overlaying them. */
  readonly stacked: boolean;
  /** Trailing averages to draw dotted over each series, aligned with `series`. Never stacked. */
  readonly averages?: readonly (readonly (number | null)[])[] | undefined;
}

/** One line per series along an ordered axis; areas stack when asked to. */
export function LineChart({
  series,
  labels,
  shortLabels,
  whole,
  area,
  stacked,
  averages,
  keys = [],
  picking,
}: LineChartProps): ReactNode {
  const prefix = useId().replaceAll(':', '');
  const geometry = lineGeometry({
    series,
    count: labels.length,
    whole,
    area,
    stacked,
    averages,
  });

  return (
    <Frame maximum={geometry.maximum} whole={whole} labels={labels} shortLabels={shortLabels}>
      <svg
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        preserveAspectRatio="none"
        className="h-48 w-full overflow-visible"
      >
        <SeriesPatterns prefix={prefix} styles={series.map((entry) => entry.style)} />
        <Gridlines />
        {picking === undefined
          ? null
          : keys.map((key, index) => {
              const count = labels.length;
              const step = count < 2 ? WIDTH : WIDTH / (count - 1);
              const centre = count < 2 ? WIDTH / 2 : (index / (count - 1)) * WIDTH;
              return (
                <Band key={key} keys={[key]} x={centre - step / 2} width={step} picking={picking} />
              );
            })}
        {geometry.areas.map((points, position) => (
          <polygon
            key={`area-${series[position]?.key ?? String(position)}`}
            points={points}
            fill={patternFill(prefix, position)}
            className={cn('pointer-events-none', geometry.stacking ? undefined : 'opacity-50')}
          />
        ))}
        {series.map((entry, position) => (
          <path
            key={`line-${entry.key}`}
            d={geometry.lines[position] ?? ''}
            fill="none"
            className={cn('pointer-events-none', entry.style.stroke)}
            strokeDasharray={entry.style.dash}
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {geometry.averages.map((d, position) => {
          const entry = series[position];
          return entry === undefined ? null : (
            <path
              key={`average-${entry.key}`}
              d={d}
              fill="none"
              className={cn('pointer-events-none', entry.style.stroke)}
              strokeDasharray="0 6"
              strokeWidth="3"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
        {geometry.points.map((point) => {
          const entry = series[point.series];
          const key = keys[point.bucket] ?? '';
          const split = series.length > 1;
          const picked = picking?.isOn([key], split ? point.series : undefined) === true;
          return entry === undefined ? null : (
            <circle
              key={`${entry.key}-${String(point.bucket)}`}
              cx={point.cx}
              cy={point.cy}
              r="0.01"
              fill="none"
              className={cn(
                entry.style.stroke,
                picking !== undefined && 'cursor-pointer hover:opacity-80 active:opacity-65',
              )}
              strokeWidth={picked ? 11 : 6}
              onClick={
                picking === undefined
                  ? undefined
                  : () => {
                      picking.toggle([key], split ? point.series : undefined);
                    }
              }
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            >
              <title>{`${labels[point.bucket] ?? ''}, ${entry.label}: ${formatMeasure(entry.values[point.bucket] ?? 0)}`}</title>
            </circle>
          );
        })}
      </svg>
    </Frame>
  );
}

export interface PieSlice {
  readonly key: string;
  /** The bucket keys the slice stands for: one, or every folded value for Other. */
  readonly keys?: readonly string[];
  readonly label: string;
  readonly value: number;
  readonly style: SeriesStyle;
}

/** Shares of the whole. Slices run clockwise from twelve o'clock in the order given. */
export function PieChart({
  slices,
  picking,
}: {
  readonly slices: readonly PieSlice[];
  readonly picking?: ChartPicking | undefined;
}): ReactNode {
  const prefix = useId().replaceAll(':', '');
  const geometry = pieGeometry(slices.map((slice) => slice.value));

  return (
    <svg viewBox="-1.05 -1.05 2.1 2.1" className="mx-auto size-48 max-w-full" aria-hidden="true">
      <SeriesPatterns prefix={prefix} styles={slices.map((slice) => slice.style)} />
      {geometry.total === 0 ? (
        <circle cx="0" cy="0" r="1" className="fill-divider" />
      ) : (
        geometry.slices.map(({ index, share, d }) => {
          const slice = slices[index];
          if (slice === undefined) {
            return null;
          }
          const keys = slice.keys ?? [slice.key];
          const pickable = {
            className: cn(
              picking !== undefined && 'cursor-pointer hover:opacity-80 active:opacity-65',
              picking?.isOn(keys) === true ? 'stroke-foreground' : 'stroke-background',
            ),
            onClick:
              picking === undefined
                ? undefined
                : () => {
                    picking.toggle(keys);
                  },
          };
          const title = `${slice.label}: ${formatMeasure(slice.value)} (${String(Math.round(share * 100))}%)`;
          if (d === null) {
            return (
              <circle
                key={slice.key}
                cx="0"
                cy="0"
                r="1"
                fill={patternFill(prefix, index)}
                {...pickable}
              >
                <title>{title}</title>
              </circle>
            );
          }
          return (
            <path
              key={slice.key}
              d={d}
              fill={patternFill(prefix, index)}
              {...pickable}
              strokeWidth={picking?.isOn(keys) === true ? 2.5 : 1}
              vectorEffect="non-scaling-stroke"
            >
              <title>{title}</title>
            </path>
          );
        })
      )}
    </svg>
  );
}

/** One legend entry: a name and how its series is drawn. */
export interface LegendEntry {
  readonly key: string;
  readonly label: string;
  readonly style: SeriesStyle;
  /** Draw the sample as a dotted line in the muted tone, for the trailing average. */
  readonly dotted?: boolean;
}

/** Which tone and pattern is which series. Text, so the legend is never only a colour. */
export function ChartLegend({
  entries,
  lines,
}: {
  readonly entries: readonly LegendEntry[];
  /** Draw each sample as a line in its dash pattern rather than a filled, hatched swatch. */
  readonly lines: boolean;
}): ReactNode {
  const prefix = useId().replaceAll(':', '');
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1">
      {entries.map((entry, index) => (
        <li key={entry.key} className="flex min-w-0 max-w-full items-center gap-2">
          <svg
            viewBox={lines ? '0 0 24 8' : '0 0 12 12'}
            className={lines ? 'h-2 w-6 shrink-0' : 'size-3 shrink-0'}
            aria-hidden="true"
          >
            {lines || entry.dotted === true ? (
              <line
                x1="2"
                x2="22"
                y1="4"
                y2="4"
                className={entry.dotted === true ? 'stroke-muted' : entry.style.stroke}
                strokeDasharray={entry.dotted === true ? '0 6' : entry.style.dash}
                strokeWidth={entry.dotted === true ? 3 : 2}
                strokeLinecap="round"
              />
            ) : (
              <>
                <SeriesPatterns prefix={`${prefix}-${String(index)}`} styles={[entry.style]} />
                <rect
                  width="12"
                  height="12"
                  rx="2"
                  fill={patternFill(`${prefix}-${String(index)}`, 0)}
                />
              </>
            )}
          </svg>
          <Text as="span" variant="caption" className="min-w-0">
            {entry.label}
          </Text>
        </li>
      ))}
    </ul>
  );
}
