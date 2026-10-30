import { describe, expect, it } from 'vitest';

import { aChart } from './fixtures.test-helper.js';
import {
  bucketLabel,
  chartCaption,
  chartKindOf,
  cumulative,
  labelsFor,
  naturalBucketRank,
  plottedSeries,
  seriesPattern,
  trailingAverage,
} from './model.js';

const labels = labelsFor([{ key: 'done', label: 'Done', type: 'checkbox' }], 'Unset');

describe('the chart model', () => {
  it('draws an unknown kind as bars', () => {
    expect(chartKindOf('radar')).toBe('bar');
    expect(chartKindOf('pie')).toBe('pie');
  });

  it('names unset and checkbox values through the injected labels', () => {
    expect(labels.value('done', 'true')).toBe('Checked');
    expect(labels.value('status', null)).toBe('Unset');
    expect(bucketLabel(null, null, labels)).toBe('Unset');
  });

  it('names priority levels and ranks closed-set buckets naturally', () => {
    const priority = labelsFor([{ key: 'sev', label: 'Severity', type: 'priority' }], 'Unset');
    expect(priority.value('sev', '2')).toBe('P2 High');
    expect(naturalBucketRank('priority', '1')).toBeLessThan(
      naturalBucketRank('priority', '4') ?? 0,
    );
    expect(naturalBucketRank('checkbox', 'false')).toBeLessThan(
      naturalBucketRank('checkbox', 'true') ?? 0,
    );
    expect(naturalBucketRank('priority', null)).toBeGreaterThan(
      naturalBucketRank('priority', '4') ?? 0,
    );
    expect(naturalBucketRank('select', 'x')).toBeNull();
  });

  it('formats periods in a fixed locale and UTC', () => {
    expect(bucketLabel('2026-10-05', 'month', labels, null, false, 'en-GB')).toBe('Oct 2026');
    expect(bucketLabel('2026-04-01', 'quarter', labels)).toBe('Q2 2026');
  });

  it('runs totals and holds the average until a full span exists', () => {
    expect(cumulative([1, 2, 3])).toEqual([1, 3, 6]);
    expect(trailingAverage([2, 4, 6], 2)).toEqual([null, 3, 5]);
  });

  it('plots an unsplit chart as one series styled by the caller', () => {
    const series = plottedSeries(aChart(), labels, {}, seriesPattern);
    expect(series).toHaveLength(1);
    expect(series[0]?.values).toEqual([3, 1, 2]);
    expect(series[0]?.style).toEqual({ role: 0, dash: undefined, hatch: 'none' });
  });

  it('gives Other the muted role and its own pattern', () => {
    expect(seriesPattern(2, true)).toEqual({ role: 6, dash: '1 4', hatch: 'back' });
    expect(seriesPattern(7, false).role).toBe(1);
  });

  it('captions with the injected day formatter', () => {
    const caption = chartCaption(
      aChart({ period: 'month', from: '2026-01-01', to: '2026-03-31' }),
      labels,
      (day) => `[${day ?? ''}]`,
    );
    expect(caption).toBe('How many items per month of status, [2026-01-01] to [2026-03-31]');
  });
});
