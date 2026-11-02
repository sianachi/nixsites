/**
 * Exact decimals for money, standing in for C#'s `decimal`: a BigInt scaled by 10^12, so sums
 * and products of amounts (two places) and rates (six places) never touch a JS float.
 */
export type Dec = bigint;

const SCALE_DIGITS = 12;
export const S: Dec = 10n ** BigInt(SCALE_DIGITS);
export const ZERO: Dec = 0n;

/** Parses decimal text (`12.5`, `-3`, `1e-7`); null when it is not a plain number. */
export function parseDec(text: string): Dec | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (match === null) return null;
  const fraction = match[3] ?? '';
  const shift = SCALE_DIGITS + Number(match[4] ?? 0) - fraction.length;
  const digits = BigInt(`${match[2] ?? '0'}${fraction}`);
  const scaled = shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
  return match[1] === '-' ? -scaled : scaled;
}

/** A JSON number as the decimal its text spells; null for anything else. */
export function decOf(value: unknown): Dec | null {
  return typeof value === 'number' && Number.isFinite(value) ? parseDec(String(value)) : null;
}

/** The JSON number Core would write for this decimal. */
export function num(d: Dec): number {
  const magnitude = d < 0n ? -d : d;
  const fraction = (magnitude % S).toString().padStart(SCALE_DIGITS, '0').replace(/0+$/, '');
  return Number(
    `${d < 0n ? '-' : ''}${String(magnitude / S)}${fraction === '' ? '' : `.${fraction}`}`,
  );
}

export const mul = (a: Dec, b: Dec): Dec => (a * b) / S;
export const abs = (d: Dec): Dec => (d < 0n ? -d : d);
export const sum = <T>(items: Iterable<T>, pick: (item: T) => Dec): Dec => {
  let total = ZERO;
  for (const item of items) total += pick(item);
  return total;
};

type Mode = 'away' | 'even';

/** round(numerator / denominator, places) exactly, as a Dec. */
export function roundRatio(
  numerator: bigint,
  denominator: bigint,
  places: number,
  mode: Mode,
): Dec {
  const sign = numerator < 0n !== denominator < 0n ? -1n : 1n;
  const n = (numerator < 0n ? -numerator : numerator) * 10n ** BigInt(places);
  const d = denominator < 0n ? -denominator : denominator;
  let q = n / d;
  const twice = (n % d) * 2n;
  if (twice > d || (twice === d && (mode === 'away' || q % 2n === 1n))) q += 1n;
  return sign * q * 10n ** BigInt(SCALE_DIGITS - places);
}

/** decimal.Round(d, places), the default: ties to even. */
export const roundEven = (d: Dec, places: number): Dec => roundRatio(d, S, places, 'even');
/** MoneyRules.Round: two places, ties away from zero. */
export const roundMoney = (d: Dec): Dec => roundRatio(d, S, 2, 'away');

/** a / b rounded to `places`, ties to even, exactly. */
export const ratio = (a: Dec, b: Dec, places: number): Dec => roundRatio(a, b, places, 'even');

const MAXIMUM: Dec = 99_999_999_999n * 10n ** 10n;

/** MoneyRules.IsAmount: within a billion, at most two places. */
export const isAmount = (d: Dec): boolean => d >= -MAXIMUM && d <= MAXIMUM && d % 10n ** 10n === 0n;
/** At most `places` fractional digits. */
export const hasPlaces = (d: Dec, places: number): boolean =>
  d % 10n ** BigInt(SCALE_DIGITS - places) === 0n;

/** An element the caller has just proved exists. */
export function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('unreachable: a checked element is missing');
  return value;
}
