import { describe, expect, it } from 'vitest';

import { continueSeries } from '../../../lib/suggest/fill-series';

describe('continuing a series', () => {
  it('continues an arithmetic number series, keeping the seed precision', () => {
    expect(continueSeries(['10', '20', '30'], 2)).toEqual({
      kind: 'number',
      values: ['40', '50'],
      describe: '+10',
    });
    expect(continueSeries(['1.5', '2.0'], 2)?.values).toEqual(['2.5', '3.0']);
    expect(continueSeries(['5', '3'], 2)?.values).toEqual(['1', '-1']);
  });

  it('refuses a number seed whose steps disagree, and repeats instead', () => {
    expect(continueSeries(['1', '2', '4'], 2)).toEqual({
      kind: 'repeat',
      values: ['4', '4'],
      describe: 'repeating',
    });
  });

  it('continues daily and weekly date series across a month end', () => {
    expect(continueSeries(['2026-01-30', '2026-01-31'], 2)).toMatchObject({
      kind: 'date',
      values: ['2026-02-01', '2026-02-02'],
      describe: 'daily',
    });
    expect(continueSeries(['2026-03-02', '2026-03-09'], 2)).toMatchObject({
      values: ['2026-03-16', '2026-03-23'],
      describe: 'weekly',
    });
  });

  it('continues a monthly series on the same day, clamping to short months', () => {
    expect(continueSeries(['2026-01-31', '2026-02-28'], 3)).toMatchObject({
      kind: 'date',
      values: ['2026-03-31', '2026-04-30', '2026-05-31'],
      describe: 'monthly',
    });
    expect(continueSeries(['2026-01-15', '2026-04-15'], 1)).toMatchObject({
      values: ['2026-07-15'],
      describe: 'every 3 months',
    });
  });

  it('continues text with one incrementing number, wherever the number sits', () => {
    expect(continueSeries(['Week 1', 'Week 2'], 2)).toEqual({
      kind: 'text',
      values: ['Week 3', 'Week 4'],
      describe: '+1',
    });
    expect(continueSeries(['Q1 2026', 'Q2 2026'], 1)?.values).toEqual(['Q3 2026']);
    expect(continueSeries(['Sprint 09 review', 'Sprint 10 review'], 1)?.values).toEqual([
      'Sprint 11 review',
    ]);
  });

  it('keeps zero padding the seed shows', () => {
    expect(continueSeries(['Item 008', 'Item 009'], 2)?.values).toEqual(['Item 010', 'Item 011']);
  });

  it('does not guess when two numbers vary at once', () => {
    expect(continueSeries(['1/1', '2/3'], 1)?.kind).toBe('repeat');
  });

  it('repeats a single seed or a constant one', () => {
    expect(continueSeries(['Done'], 2)?.values).toEqual(['Done', 'Done']);
    expect(continueSeries(['7', '7'], 1)?.kind).toBe('repeat');
  });

  it('answers nothing for an empty seed or a zero count', () => {
    expect(continueSeries([], 3)).toBeNull();
    expect(continueSeries(['1', '2'], 0)).toBeNull();
    expect(continueSeries(['1', ''], 2)).toBeNull();
  });

  it('does not count a text series down past zero', () => {
    expect(continueSeries(['Day 2', 'Day 1'], 2)?.kind).toBe('repeat');
  });

  it('refuses an impossible date rather than rolling it over', () => {
    expect(continueSeries(['2026-02-30', '2026-03-01'], 1)?.kind).not.toBe('date');
  });
});
