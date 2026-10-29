import { fireEvent, render, screen } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import type { PropertyDefinition, View } from '../../../collections/core/container-model';
import { StructuredViewConfiguration } from '../../../views/core/structured-view-configuration';
import { normalizeChartView } from '../../../views/chart/chart-options';
import { aView } from '../../view-fixture';

const fields: PropertyDefinition[] = [
  { key: 'status', label: 'Status', type: 'select', options: ['Open', 'Done'], required: false },
  { key: 'done_on', label: 'Done on', type: 'date', options: [], required: false },
  { key: 'urgent', label: 'Urgent', type: 'checkbox', options: [], required: false },
  { key: 'notes', label: 'Notes', type: 'text', options: [], required: false },
] as PropertyDefinition[];

function chartView(over: Partial<View> = {}): View {
  return aView({ id: 'c', kind: 'chart', groupBy: 'status', ...over });
}

function Harness({ initial }: { readonly initial: View }): ReactNode {
  const [view, setView] = useState(initial);
  return (
    <>
      <StructuredViewConfiguration view={view} fields={fields} onChange={setView} />
      <output data-testid="saved">{JSON.stringify(view.chart)}</output>
    </>
  );
}

function saved(): unknown {
  return JSON.parse(screen.getByTestId('saved').textContent);
}

describe('chart options', () => {
  it('leave an untouched chart of categories with no options at all', () => {
    expect(normalizeChartView(chartView(), fields).chart).toBeNull();
  });

  it('put a chart grouped by a date on a monthly axis, and take the axis away for a select', () => {
    const dated = normalizeChartView(chartView({ groupBy: 'done_on' }), fields);
    expect(dated.chart?.period).toBe('month');

    if (dated.chart === null || dated.chart === undefined) {
      throw new Error('A dated chart has options.');
    }
    const back = normalizeChartView(
      { ...dated, groupBy: 'status', chart: { ...dated.chart, kind: 'line', lastPeriods: 6 } },
      fields,
    );
    expect(back.chart).toBeNull();
  });

  it('count a year grid by day and never split it', () => {
    const year = normalizeChartView(
      chartView({
        groupBy: 'done_on',
        chart: {
          kind: 'year',
          period: 'week',
          splitBy: 'status',
          lastPeriods: null,
          from: null,
          to: null,
          cumulative: true,
          rollingAverage: null,
          stacked: null,
        },
      }),
      fields,
    );

    expect(year.chart).toMatchObject({
      kind: 'year',
      period: 'day',
      splitBy: null,
      cumulative: null,
    });
  });

  it('offer line, area and the year grid only once the chart groups by a date', () => {
    render(<Harness initial={chartView()} />);

    const type = screen.getByRole('combobox', { name: 'Chart type' });
    expect(Array.from(type.querySelectorAll('option')).map((option) => option.value)).toEqual([
      'bar',
      'column',
      'pie',
    ]);

    fireEvent.change(screen.getByRole('combobox', { name: 'Group by' }), {
      target: { value: 'done_on' },
    });

    expect(saved()).toMatchObject({ period: 'month' });
    expect(
      Array.from(
        screen.getByRole('combobox', { name: 'Chart type' }).querySelectorAll('option'),
      ).map((option) => option.value),
    ).toEqual(['bar', 'column', 'pie', 'line', 'area', 'year']);
    expect(screen.getByRole('combobox', { name: 'Count per' })).toHaveValue('month');
  });

  it('edit the window, the split and the line toggles', () => {
    render(<Harness initial={chartView({ groupBy: 'done_on' })} />);

    fireEvent.change(screen.getByRole('combobox', { name: 'Chart type' }), {
      target: { value: 'line' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Count per' }), {
      target: { value: 'week' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Show' }), {
      target: { value: 'last' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'How many periods' }), {
      target: { value: '26' },
    });

    // Only a select or a checkbox splits; free text would be a legend nobody can read.
    const split = screen.getByRole('combobox', { name: 'Split by' });
    expect(Array.from(split.querySelectorAll('option')).map((option) => option.value)).toEqual([
      '',
      'status',
      'urgent',
    ]);
    fireEvent.change(split, { target: { value: 'urgent' } });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Running total' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '7-period average' }));

    expect(saved()).toEqual({
      kind: 'line',
      period: 'week',
      splitBy: 'urgent',
      lastPeriods: 26,
      from: null,
      to: null,
      cumulative: true,
      rollingAverage: true,
      stacked: null,
    });
  });
});
