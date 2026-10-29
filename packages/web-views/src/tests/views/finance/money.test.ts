import { describe, expect, it } from 'vitest';
import {
  compareMonths,
  formatMoney,
  formatMonth,
  monthOf,
  parseAmount,
  shiftMonth,
} from '../../../finance/money';

describe('money formatting', () => {
  it('prints an amount in the currency with two places and a sign when asked', () => {
    expect(formatMoney(12.4, 'GBP')).toMatch(/12\.40/);
    expect(formatMoney(12.4, 'GBP')).toContain('£');
    expect(formatMoney(12.4, 'GBP', { signed: true })).toMatch(/^\+/);
    expect(formatMoney(-12.4, 'GBP', { signed: true })).toMatch(/^-/);
    expect(formatMoney(0, 'GBP', { signed: true })).not.toMatch(/^[+-]/);
  });

  it('names a month from yyyy-MM and leaves anything else alone', () => {
    const september = new Date(Date.UTC(2026, 8, 1));
    expect(formatMonth('2026-09')).toBe(
      new Intl.DateTimeFormat(undefined, {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(september),
    );
    expect(formatMonth('2026-09', 'long')).toBe(
      new Intl.DateTimeFormat(undefined, {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(september),
    );
    expect(formatMonth('not a month')).toBe('not a month');
  });

  it('shifts months across year ends and compares them as text', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-08', 11)).toBe('2027-07');
    expect(compareMonths('2026-08', '2027-01')).toBeLessThan(0);
    expect(monthOf('2026-09-21')).toBe('2026-09');
  });

  it('reads a typed amount and refuses what is not one', () => {
    expect(parseAmount('12.40')).toBe(12.4);
    expect(parseAmount('£1,234.56')).toBe(1234.56);
    expect(parseAmount('-3.2')).toBe(-3.2);
    expect(parseAmount('.5')).toBe(0.5);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('12oops')).toBeNull();
    expect(parseAmount('1e3')).toBeNull();
    expect(parseAmount('1,23')).toBeNull();
    expect(parseAmount('12.345')).toBeNull();
    expect(parseAmount('-')).toBeNull();
  });
});
