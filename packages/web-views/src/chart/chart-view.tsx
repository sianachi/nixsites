import type { ItemChart } from '@nix/api-client';
import type { Item } from '@nix/web-collections/core/container-model';
import { Button, Segmented, Text, cn, focusRing } from '@nix/ui';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import {
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
} from '@nix/web-foundation/components/states/status-panels';
import {
  readPropertyText,
  type PropertyDefinition,
} from '@nix/web-collections/core/container-model';
import type { ViewRendererProps } from '../core/view-kinds';
import { Drawing } from './chart-drawing';
import {
  bucketKey,
  bucketLabel,
  CHART_KIND_LABELS,
  chartCaption,
  chartKindOf,
  chartLabels,
  inNaturalOrder,
  countOf,
  formatDay,
  isChartPeriod,
  type ChartKind,
  type ChartLabels,
} from './chart-model';
import { offeredChartKinds } from './chart-options';
import { Notices } from './chart-notices';
import {
  pickedItems,
  samePick,
  validPick,
  type ChartPick,
  type ChartPicking,
} from './chart-selection';
import { useChart } from './use-chart';

/**
 * The chart view: a container's children summarised into bars, columns, a pie, lines, areas or a
 * year grid.
 *
 * **The third kind whose data is not the loaded children.** Its buckets come from
 * `GET /items/{id}/chart`, computed over every child rather than over the page the container
 * happens to hold - a chart tallied in the browser from the first two hundred of three thousand
 * would be a picture of the first page presented as a picture of the whole. `container.children` is
 * deliberately ignored, and so is `useViewChrome`, whose filter and sort branches are statements
 * about children this view does not draw.
 *
 * **One source for every option.** The chart's type, period, split, window and line options are all
 * read from the server's payload - the stored configuration the buckets were computed from - never
 * mixed with the client's copy of the view, which may already be newer. A change to the stored view
 * changes its fingerprint, and the chart is read again.
 *
 * **Every type is a table that happens to be drawn.** The numbers are text in the markup and the
 * drawing is `aria-hidden` decoration over them, so a screen reader gets the figures rather than a
 * description of a picture, and a copy-paste gets data. Bars keep the oldest form of that rule - the
 * bar sits behind its own row - and every other type draws above a table of the same figures. The
 * year grid's days carry their sentences, with the full table behind a disclosure because a year of
 * days is a long table.
 *
 * **Unset is a bar, and undated and out-of-window are said.** A container half of whose children
 * have no status is mostly a container of unset things, and dropping that bucket would misreport
 * every proportion beside it. On a time axis an item with no date, or one outside the window, has
 * no period to sit in, so it is counted and the chart says how many rather than quietly shrinking.
 */
export function ChartView(props: ViewRendererProps): ReactNode {
  const { container, view } = props;
  const fields = container.schema?.properties ?? [];

  // What the stored configuration is, so a saved change is read again rather than left drawn.
  const fingerprint = JSON.stringify([
    view.groupBy,
    view.measure ?? null,
    view.measureProperty ?? null,
    view.chart ?? null,
  ]);
  const run = useChart(container.itemId ?? '', view.id, fingerprint);

  if (run.status === 'loading') {
    return <LoadingPanel label="this chart" />;
  }

  if (run.status === 'error' || run.chart === null) {
    // Retrying cannot finish a configuration or unlock an item, so only a failure that a second
    // attempt could fix offers one.
    const retryable = run.failure === 'unavailable' || run.failure === null;
    return (
      <ErrorPanel
        title="This chart could not be drawn"
        detail={run.error ?? 'The chart could not be read.'}
        action={
          retryable ? (
            <Button
              variant="secondary"
              onClick={() => {
                void run.reload();
              }}
            >
              Try again
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <ChartBody
      chart={run.chart}
      fields={fields}
      items={container.children}
      partial={container.truncated}
      onOpen={props.onOpen}
    />
  );
}

export interface ChartBodyProps {
  readonly chart: ItemChart;
  /** The container's property definitions, which name the keys and values the payload carries. */
  readonly fields?: readonly PropertyDefinition[] | undefined;
  /** The loaded children. When given, a mark can be picked to list the items behind it. */
  readonly items?: readonly Item[] | undefined;
  /** Whether `items` is only the first pages of a larger container. */
  readonly partial?: boolean | undefined;
  readonly onOpen?: ((itemId: string) => void) | undefined;
}

const PICK_NOUN: Record<ChartKind, string> = {
  bar: 'a bar',
  column: 'a column',
  pie: 'a slice',
  line: 'a point',
  area: 'a point',
  year: 'a day',
};

/**
 * A loaded chart, drawn as its type says. Separate from {@link ChartView} so stories and tests can
 * hand it a payload without a server.
 *
 * **Two things the person does here, both view-local.** The type can be switched from the chart
 * itself (a view-local choice that keeps the grouping and split the stored view computed; only the
 * types the payload's period can draw are offered), and a bar, column, slice, point or day can be
 * picked to list the items behind it beside the chart (below it on a phone). Neither writes the
 * stored view.
 */
export function ChartBody({
  chart: loaded,
  fields = [],
  items,
  partial = false,
  onOpen,
}: ChartBodyProps): ReactNode {
  const panel = useRef<HTMLElement>(null);
  const [chosenKind, setChosenKind] = useState<ChartKind | null>(null);
  const [chosenPick, setChosenPick] = useState<ChartPick | null>(null);

  const chart = inNaturalOrder(loaded, fields);
  const labels = chartLabels(fields);
  const timeAxis = isChartPeriod(chart.period);
  const offered = offeredChartKinds(timeAxis, chart.period).filter(
    (offer) => offer !== 'year' || chart.period === 'day',
  );
  const stored = chartKindOf(chart.chartKind);
  const kind = chosenKind !== null && offered.includes(chosenKind) ? chosenKind : stored;
  const caption = chartCaption(chart, labels);
  const pick = validPick(chart, chosenPick);
  const pickId = pick === null ? '' : `${pick.keys.join('|')}#${String(pick.series)}`;

  // Bring the list into view when something is picked (it sits below the chart on a phone).
  useEffect(() => {
    const element = panel.current;
    if (pickId !== '' && element !== null && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'nearest' });
    }
  }, [pickId]);

  if (
    chart.buckets.length === 0 &&
    chart.children === 0 &&
    chart.unplaced === 0 &&
    chart.outsideWindow === 0
  ) {
    return (
      <EmptyPanel
        title="Nothing to summarise yet"
        detail={`This chart groups the items inside this one by "${labels.property(chart.groupBy)}". Add some and it fills in.`}
      />
    );
  }

  function changeKind(next: ChartKind): void {
    if (next === kind) return;
    setChosenKind(next);
  }

  function setPick(next: ChartPick | null): void {
    setChosenPick(next);
  }

  const picking: ChartPicking | undefined =
    items === undefined
      ? undefined
      : {
          toggle: (keys, series) => {
            const next = { keys, series: series ?? null };
            setPick(samePick(pick, next) ? null : next);
          },
          isOn: (keys, series) => samePick(pick, { keys, series: series ?? null }),
        };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (
      event.key === 'Escape' &&
      pick !== null &&
      !/^(SELECT|INPUT|TEXTAREA)$/.test(target.tagName)
    ) {
      setPick(null);
    }
  };

  const picked = pick === null || items === undefined ? [] : pickedItems(chart, items, pick);

  return (
    // The key handler is Escape-to-clear for the selection; every pick also has a visible Clear.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_calc(var(--spacing)*80)] lg:items-start"
      onKeyDown={onKeyDown}
    >
      <div className="flex min-w-0 flex-col gap-3">
        <Text as="h3" variant="h6">
          {caption}
        </Text>

        <Segmented
          label="Chart type"
          options={offered.map((offer) => ({ value: offer, label: CHART_KIND_LABELS[offer] }))}
          value={kind}
          onChange={changeKind}
        />
        <span role="status" className="sr-only">
          {`Showing ${CHART_KIND_LABELS[kind].toLowerCase()}`}
        </span>

        <Notices chart={chart} labels={labels} />

        {chart.buckets.length === 0 ? (
          <Text variant="bodySmall" tone="muted">
            {timeAxis && chart.from !== null && chart.to !== null
              ? `Nothing between ${formatDay(chart.from)} and ${formatDay(chart.to)}.`
              : timeAxis && chart.from !== null
                ? `Nothing since ${formatDay(chart.from)}.`
                : 'There is nothing to draw.'}
          </Text>
        ) : (
          <div key={kind} data-enter="">
            <Drawing
              chart={chart}
              kind={kind}
              labels={labels}
              caption={caption}
              picking={picking}
            />
          </div>
        )}

        <Text variant="note" tone="muted">
          {`${chart.measure === 'sum' ? 'Totalled' : 'Counted'} across ${chart.children === 1 ? 'the 1 item' : `all ${countOf(chart.children, 'item')}`} inside this one${timeAxis ? ' that fall in these periods' : ''}.`}
        </Text>
      </div>

      {picking === undefined ? null : (
        <aside
          ref={panel}
          aria-label="Items"
          aria-live="polite"
          className="flex min-h-18 flex-col gap-2 rounded-md border border-divider bg-surface p-3 lg:sticky lg:top-4 lg:max-h-[80vh] lg:overflow-auto"
        >
          {pick === null ? (
            <Text variant="bodySmall" tone="muted">
              {`Click or tap ${PICK_NOUN[kind]} to list the items in it.`}
            </Text>
          ) : (
            <div
              key={pick.keys.join('|') + String(pick.series)}
              data-enter=""
              className="flex flex-col gap-2"
            >
              <div className="flex items-start justify-between gap-2">
                <Text as="h4" variant="h6">
                  {`${describe(chart, labels, pick)} · ${countOf(picked.length, 'item')}`}
                </Text>
                <Button
                  variant="secondary"
                  aria-label="Clear selection"
                  title="Clear selection (Esc)"
                  onClick={() => {
                    setPick(null);
                  }}
                >
                  Clear
                </Button>
              </div>
              {partial ? (
                <Text variant="note" tone="muted">
                  Only the items loaded so far are listed, so this can be fewer than the figure.
                </Text>
              ) : null}
              {picked.length === 0 ? (
                <Text variant="bodySmall" tone="muted">
                  No items in this one.
                </Text>
              ) : (
                <ul className="flex flex-col">
                  {picked.map((item) => (
                    <li key={item.id} className="flex flex-col border-t border-divider py-2">
                      <button
                        type="button"
                        onClick={() => onOpen?.(item.id)}
                        className={cn(
                          'rounded-sm text-left hover:underline any-pointer-coarse:min-h-(--control-lg)',
                          focusRing,
                        )}
                      >
                        <Text as="span" variant="bodySmall">
                          {item.title === '' ? 'Untitled' : item.title}
                        </Text>
                      </button>
                      <Text variant="caption" tone="muted">
                        {metaOf(item, fields, chart)}
                      </Text>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </aside>
      )}
    </div>
  );
}

/** What a pick is, in words: the bucket (or Other) and the series, if any. */
function describe(chart: ItemChart, labels: ChartLabels, pick: ChartPick): string {
  const [first] = pick.keys;
  const bucket = chart.buckets.find((candidate) => bucketKey(candidate) === first);
  const name =
    pick.keys.length > 1 || bucket === undefined
      ? `Other (${countOf(pick.keys.length, 'value')})`
      : bucketLabel(bucket.value, chart.period, labels, chart.groupBy);
  const series = pick.series === null ? undefined : chart.series[pick.series];
  return series === undefined
    ? name
    : `${name} · ${series.other ? 'Other' : labels.value(chart.splitBy, series.value)}`;
}

/** The first few things worth knowing about an item that the chart is not already saying. */
function metaOf(item: Item, fields: readonly PropertyDefinition[], chart: ItemChart): string {
  return fields
    .filter((field) => field.key !== chart.groupBy && field.key !== chart.splitBy)
    .map((field) => readPropertyText(item, field.key))
    .filter((text) => text !== '')
    .slice(0, 3)
    .join(' · ');
}
