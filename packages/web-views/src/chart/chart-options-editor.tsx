import { Checkbox, Field, Input, Select, Text } from '@nix/ui';
import { useState, type ReactNode } from 'react';

import { todayDay } from '@nix/web-collections/core/day-math';
import { addDays, dayText } from '@nix/web-collections/core/calendar-dates';
import type {
  ChartOptions,
  PropertyDefinition,
  View,
} from '@nix/web-collections/core/container-model';
import { canSplitBy } from '@nix/web-collections/core/property-types';
import {
  AVERAGE_SPAN,
  CHART_KIND_LABELS,
  CHART_PERIOD_LABELS,
  CHART_PERIODS,
  chartKindOf,
  MAXIMUM_CHART_PERIODS,
  MAXIMUM_SERIES,
  TIME_AXIS_KINDS,
  type ChartKind,
} from './chart-model';
import {
  EMPTY_CHART_OPTIONS,
  groupsByDate,
  normalizeChartView,
  offeredChartKinds,
} from './chart-options';

export interface ChartOptionsEditorProps {
  readonly view: View;
  readonly fields: readonly PropertyDefinition[];
  readonly onChange: (view: View) => void;
}

type WindowShape = 'all' | 'last' | 'range';

/** Core's own sentence for a window whose ends cross, so the editor and the server agree. */
const CROSSED_WINDOW = 'A window must end on or after the day it starts.';

/**
 * The chart view's own settings: its type, time axis, series and window.
 *
 * Shown only for what the chosen grouping can use - a period only for a date, line and area and the
 * year grid only along one, a window only once there is a period - and every change goes through
 * {@link normalizeChartView}, so what is saved is always something Core stores and the chart draws
 * as the editor showed it. When normalising changes the type - a line whose grouping is no longer a
 * date becomes bars - the editor says so in one line rather than letting it happen silently.
 */
export function ChartOptionsEditor({ view, fields, onChange }: ChartOptionsEditorProps): ReactNode {
  const options = view.chart ?? EMPTY_CHART_OPTIONS;
  const dated = groupsByDate(view, fields);
  const kind: ChartKind = chartKindOf(options.kind);
  const windowShape: WindowShape =
    options.lastPeriods !== null
      ? 'last'
      : options.from !== null || options.to !== null
        ? 'range'
        : 'all';
  const splittable = fields.filter((field) => canSplitBy(field.type) && field.key !== view.groupBy);
  const periodLabel = kind === 'year' ? 'days' : 'periods';
  const defaultCount = kind === 'year' ? MAXIMUM_CHART_PERIODS : 12;

  // A type the editor itself did not choose being dropped - by a change of grouping elsewhere in
  // the form - is said once, in the render that sees it, rather than in an effect.
  const [previousKind, setPreviousKind] = useState<string | null>(options.kind);
  const [converted, setConverted] = useState<string | null>(null);
  if (previousKind !== options.kind) {
    setPreviousKind(options.kind);
    setConverted(
      previousKind !== null &&
        previousKind !== 'bar' &&
        (options.kind === null || options.kind === 'bar')
        ? `${CHART_KIND_LABELS[chartKindOf(previousKind)]} needs ${
            TIME_AXIS_KINDS.has(chartKindOf(previousKind))
              ? 'a date to group by'
              : 'a coarser period'
          }, so this chart is now drawn as bars.`
        : null,
    );
  }

  const [countDraft, setCountDraft] = useState<string | null>(null);

  const change = (patch: Partial<ChartOptions>) => {
    onChange(normalizeChartView({ ...view, chart: { ...options, ...patch } }, fields));
  };

  const crossed = options.from !== null && options.to !== null && options.to < options.from;
  const countText = countDraft ?? String(options.lastPeriods ?? defaultCount);
  const countValue = Number(countText);
  const countValid =
    Number.isInteger(countValue) && countValue >= 1 && countValue <= MAXIMUM_CHART_PERIODS;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Field
        label="Chart type"
        {...(dated ? {} : { hint: 'Group by a date to draw a line, an area or a year grid.' })}
      >
        {(control) => (
          <Select
            {...control}
            value={kind}
            onChange={(event) => {
              setConverted(null);
              change({ kind: event.target.value });
            }}
          >
            {offeredChartKinds(dated, options.period).map((value) => (
              <option key={value} value={value}>
                {CHART_KIND_LABELS[value]}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {converted === null ? null : (
        <Text variant="note" tone="muted">
          {converted}
        </Text>
      )}

      {dated && kind !== 'year' ? (
        <Field label="Count per">
          {(control) => (
            <Select
              {...control}
              value={options.period ?? 'month'}
              onChange={(event) => {
                change({ period: event.target.value });
              }}
            >
              {CHART_PERIODS.map((value) => (
                <option key={value} value={value}>
                  {CHART_PERIOD_LABELS[value]}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}

      {dated ? (
        <Field label="Show">
          {(control) => (
            <Select
              {...control}
              value={windowShape}
              onChange={(event) => {
                const shape = event.target.value as WindowShape;
                setCountDraft(null);
                change(
                  shape === 'last'
                    ? { lastPeriods: defaultCount, from: null, to: null }
                    : shape === 'range'
                      ? {
                          lastPeriods: null,
                          from: options.from ?? dayText(addDays(todayDay(), -365)),
                          to: options.to ?? dayText(todayDay()),
                        }
                      : { lastPeriods: null, from: null, to: null },
                );
              }}
            >
              <option value="all">
                {kind === 'year' ? 'The last 53 weeks' : 'Every period up to today'}
              </option>
              <option value="last">The most recent {periodLabel}</option>
              <option value="range">Between two dates</option>
            </Select>
          )}
        </Field>
      ) : null}

      {dated && windowShape === 'last' ? (
        <Field
          label={kind === 'year' ? 'How many days' : 'How many periods'}
          error={countValid ? null : `Choose from 1 to ${String(MAXIMUM_CHART_PERIODS)}.`}
        >
          {(control) => (
            <Input
              {...control}
              type="number"
              inputMode="numeric"
              min={1}
              max={MAXIMUM_CHART_PERIODS}
              value={countText}
              onChange={(event) => {
                const text = event.target.value;
                setCountDraft(text);
                const count = Number(text);
                if (Number.isInteger(count) && count >= 1 && count <= MAXIMUM_CHART_PERIODS) {
                  change({ lastPeriods: count });
                }
              }}
              onBlur={() => {
                if (countValid) setCountDraft(null);
              }}
            />
          )}
        </Field>
      ) : null}

      {dated && windowShape === 'range' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From">
            {(control) => (
              <Input
                {...control}
                type="date"
                value={options.from ?? ''}
                onChange={(event) => {
                  change({ from: event.target.value === '' ? null : event.target.value });
                }}
              />
            )}
          </Field>
          <Field label="To" error={crossed ? CROSSED_WINDOW : null}>
            {(control) => (
              <Input
                {...control}
                type="date"
                value={options.to ?? ''}
                onChange={(event) => {
                  change({ to: event.target.value === '' ? null : event.target.value });
                }}
              />
            )}
          </Field>
        </div>
      ) : null}

      {kind !== 'pie' && kind !== 'year' ? (
        <Field
          label="Split by"
          hint={
            splittable.length === 0
              ? 'There is no select, checkbox or person property to split by.'
              : `The ${String(MAXIMUM_SERIES)} largest values are drawn; the rest share Other.`
          }
        >
          {(control) => (
            <Select
              {...control}
              value={options.splitBy ?? ''}
              onChange={(event) => {
                change({ splitBy: event.target.value === '' ? null : event.target.value });
              }}
            >
              <option value="">None</option>
              {splittable.map((field) => (
                <option key={field.key} value={field.key}>
                  {field.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}

      {(kind === 'column' || kind === 'area') && options.splitBy !== null ? (
        <Checkbox
          label={kind === 'column' ? 'Stack the series in one column' : 'Stack the areas'}
          checked={options.stacked === true}
          onChange={(event) => {
            change({ stacked: event.target.checked ? true : null });
          }}
        />
      ) : null}

      {kind === 'line' || kind === 'area' ? (
        <fieldset className="flex flex-col gap-2">
          <legend>
            <Text as="span" variant="note" tone="muted">
              Lines
            </Text>
          </legend>
          <Checkbox
            label="Running total"
            checked={options.cumulative === true}
            onChange={(event) => {
              change({ cumulative: event.target.checked ? true : null });
            }}
          />
          <Checkbox
            label={`${String(AVERAGE_SPAN)}-period average`}
            checked={options.rollingAverage === true}
            onChange={(event) => {
              change({ rollingAverage: event.target.checked ? true : null });
            }}
          />
        </fieldset>
      ) : null}
    </div>
  );
}
