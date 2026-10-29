import { describe, expect, it } from 'vitest';

import {
  bucketLabel,
  chartLabels,
  chartKindOf,
  cumulative,
  plottedSeries,
  seriesStyle,
  trailingAverage,
} from '@nix/web-views/chart/chart-model';
import { aSplitChart, aTimeChart } from './chart-fixtures';

describe('the chart model', () => {
  it('draws a type it does not know as bars', () => {
    expect(chartKindOf('line')).toBe('line');
    expect(chartKindOf('radar')).toBe('bar');
    expect(chartKindOf(null)).toBe('bar');
  });

  it('names a period by what it spans', () => {
    expect(bucketLabel('2026-10-01', 'quarter')).toBe('Q4 2026');
    expect(bucketLabel('2026-01-01', 'year')).toBe('2026');
    expect(bucketLabel('2026-10-05', 'week')).toMatch(/^Week of /);
    expect(bucketLabel('Open', null)).toBe('Open');
    expect(bucketLabel(null, null)).toMatch(/unset/i);
  });

  it('keeps a running total', () => {
    expect(cumulative([1, 0, 3, 2])).toEqual([1, 1, 4, 6]);
  });

  it('averages only once a full span of periods exists', () => {
    expect(trailingAverage([1, 2, 3, 4], 3)).toEqual([null, null, 2, 3]);
    expect(trailingAverage([7, 7, 7, 7, 7, 7, 7])).toEqual([null, null, null, null, null, null, 7]);
  });

  it('plots an unsplit chart as one series named for its measure', () => {
    const [only, ...rest] = plottedSeries(aTimeChart());

    expect(rest).toEqual([]);
    expect(only?.label).toBe('Items');
    expect(only?.values.slice(0, 3)).toEqual([1, 2, 0]);
    expect(
      plottedSeries(aTimeChart(), undefined, { cumulative: true })[0]?.values.slice(0, 3),
    ).toEqual([1, 3, 3]);
  });

  it('plots each series from its cells, the unset one named as unset', () => {
    const series = plottedSeries(aSplitChart());

    expect(series.map((entry) => entry.label)).toEqual(['Ada', expect.stringMatching(/unset/i)]);
    expect(series.map((entry) => entry.values)).toEqual([
      [4, 1],
      [2, 2],
    ]);
  });

  it('tells six series apart by colour role, dash and hatch, and Other from all of them', () => {
    const styles = Array.from({ length: 6 }, (_, index) => seriesStyle(index, false));
    const other = seriesStyle(0, true);

    expect(new Set(styles.map((style) => style.fill)).size).toBe(6);
    expect(new Set(styles.map((style) => style.dash ?? 'solid')).size).toBe(6);
    expect(new Set(styles.map((style) => style.hatch)).size).toBe(6);
    expect(styles.map((style) => style.fill)).not.toContain(other.fill);
    expect(styles.map((style) => style.hatch)).not.toContain(other.hatch);
  });

  it('names a checkbox value in words and an unknown key as itself', () => {
    const labels = chartLabels([
      { key: 'done', label: 'Done', type: 'checkbox', options: [], required: false },
    ] as never);

    expect(labels.property('done')).toBe('Done');
    expect(labels.property('mystery')).toBe('mystery');
    expect(labels.value('done', 'true')).toBe('Checked');
    expect(labels.value('done', 'false')).toBe('Not checked');
    expect(labels.value('done', null)).toMatch(/unset/i);
  });
});
