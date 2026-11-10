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

export const sum = <T>(items: Iterable<T>, pick: (item: T) => Dec): Dec => {
  let total = ZERO;
  for (const item of items) total += pick(item);
  return total;
};

/** An element the caller has just proved exists. */
export function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('unreachable: a checked element is missing');
  return value;
}
