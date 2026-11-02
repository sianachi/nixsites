/* eslint-disable @typescript-eslint/restrict-template-expressions -- ported refusal text interpolates Core's numeric limits; request-shape checks are narrowed by hand */
/**
 * The value semantics Core gets from Postgres, written down once: jsonb text, text collation,
 * day arithmetic and the stored-number reading. Port of `NumberSql` and the `->>` / `left` /
 * ordering behaviour `QuerySql` relies on.
 */

/** Core could not be matched faithfully for this request; the caller answers null. */
export class Unanswerable extends Error {}

const encoder = new TextEncoder();

function byteCompare(a: string, b: string): number {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** jsonb orders object keys by byte length, then bytewise. */
export function jsonbKeyOrder(a: string, b: string): number {
  return encoder.encode(a).length - encoder.encode(b).length || byteCompare(a, b);
}

function numberText(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) >= 1e21) return BigInt(n).toString();
  return String(n);
}

function jsonbText(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return numberText(value);
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(', ')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    jsonbKeyOrder(a, b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${jsonbText(v)}`).join(', ')}}`;
}

/** `properties ->> key`: text of the value, null when absent or JSON null. */
export function textOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return numberText(value);
  if (typeof value === 'boolean') return String(value);
  return jsonbText(value);
}

/** What jsonb::text does to a bag's key order, so a row's properties read as Core wrote them. */
export function jsonbCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonbCanonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => jsonbKeyOrder(a, b))
        .map(([k, v]) => [k, jsonbCanonical(v)]),
    );
  }
  return value;
}

/** `jsonb_typeof`. */
export function jsonType(
  value: unknown,
): 'null' | 'string' | 'number' | 'boolean' | 'array' | 'object' | undefined {
  if (value === undefined) return undefined;
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value as 'string' | 'number' | 'boolean' | 'object';
}

// shortcut: Postgres sorts text with the database collation (glibc en_US.UTF-8, which ignores
// punctuation and spaces at the first levels: "-4" sorts after "3"). ICU's en collation with
// ignorePunctuation agrees for letters, digits and common punctuation but can differ for rare
// symbols, scripts and strings that differ only by punctuation. Upgrade by porting glibc's table
// if a real list ever disagrees.
const collator = new Intl.Collator('en-US', { ignorePunctuation: true });

/** Text ordering as `ORDER BY` / `<` / `BETWEEN` do it: collation first, bytes as the tie-break. */
export function collate(a: string, b: string): number {
  return collator.compare(a, b) || byteCompare(a, b);
}

/** `left(text, 10)`, counting characters as Postgres does. */
export function left10(text: string): string {
  return Array.from(text).slice(0, 10).join('');
}

/** Postgres's `ILIKE '%value%'` with the value escaped: a case-insensitive substring test. */
export function containsText(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

const FINITE = /^[ \t\n\v\f\r]*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\v\f\r]*$/;

/** The number a rule's value reads as, or null: .NET's `NumberStyles.Float` on finite doubles. */
export function parseFiniteNumber(value: string): number | null {
  if (!FINITE.test(value)) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : null;
}

/** `NumberSql.Number`: a stored JSON number, never number-shaped text. */
export function storedNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

// Days are epoch-day numbers (days since 1970-01-01), the shape of .NET's DateOnly.
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIN_DAY = epochDay(1, 1, 1);
const MAX_DAY = epochDay(9999, 12, 31);

function epochDay(year: number, month: number, day: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return Math.round(date.getTime() / 86_400_000);
}

/** `DateOnly.TryParseExact(text, "yyyy-MM-dd")`. */
export function parseDay(text: string): number | null {
  const m = DAY.exec(text);
  if (m === null) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const n = epochDay(year, month, day);
  const back = new Date(n * 86_400_000);
  return back.getUTCMonth() === month - 1 && back.getUTCDate() === day ? n : null;
}

export function formatDay(n: number): string {
  const d = new Date(n * 86_400_000);
  const year = String(d.getUTCFullYear()).padStart(4, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** `DateOnly.AddDays`, saturating at the calendar's ends the way the timestamp rules need. */
export function addDaysClamped(n: number, days: number): number {
  return Math.min(MAX_DAY, Math.max(MIN_DAY, n + days));
}

/** `DateOnly.AddMonths(-1)`: the same day of the previous month, clamped to its last day. */
export function sameDayLastMonth(n: number): number {
  const d = new Date(n * 86_400_000);
  const year = d.getUTCMonth() === 0 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
  const month = (d.getUTCMonth() + 11) % 12;
  const last = new Date(0);
  last.setUTCFullYear(year, month + 1, 0);
  return epochDay(year, month + 1, Math.min(d.getUTCDate(), last.getUTCDate()));
}

export function startOfMonth(n: number): number {
  const d = new Date(n * 86_400_000);
  return epochDay(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** Monday on or before the day. */
export function startOfWeek(n: number): number {
  const weekday = new Date(n * 86_400_000).getUTCDay();
  return n - ((weekday + 6) % 7);
}

/** A stored timestamp: whole milliseconds plus the digits below them, for exact ordering. */
export interface Stamp {
  readonly ms: number;
  readonly sub: string;
}

export function parseStamp(text: string): Stamp {
  const m = /^(.*?)(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (m === null) throw new Unanswerable('timestamp');
  const fraction = (m[2] ?? '').padEnd(9, '0');
  const ms = Date.parse(`${m[1]}.${fraction.slice(0, 3)}${m[3]}`);
  if (Number.isNaN(ms)) throw new Unanswerable('timestamp');
  return { ms, sub: fraction.slice(3) };
}

export function compareStamps(a: Stamp, b: Stamp): number {
  return a.ms - b.ms || (a.sub < b.sub ? -1 : a.sub > b.sub ? 1 : 0);
}

/** The first instant of a calendar day in an IANA zone (NodaTime's `AtStartOfDay`), in ms. */
const startOfDayCache = new Map<string, number>();

/** Rules compare every row against the same few days, so each (day, zone) is worked out once. */
export function startOfDayIn(day: number, zone: string | null): number {
  if (zone === null || zone === 'UTC') return day * 86_400_000;
  const key = `${String(day)}|${zone}`;
  const cached = startOfDayCache.get(key);
  if (cached !== undefined) return cached;
  if (startOfDayCache.size > 1024) startOfDayCache.clear();
  const found = computeStartOfDay(day, zone);
  startOfDayCache.set(key, found);
  return found;
}

function computeStartOfDay(day: number, zone: string): number {
  const midnight = day * 86_400_000;
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    return midnight; // NodaTime's GetZoneOrNull(name) is null for an unknown zone: UTC
  }
  const localDay = (instant: number): number => {
    const parts = Object.fromEntries(format.formatToParts(instant).map((p) => [p.type, p.value]));
    return epochDay(Number(parts.year), Number(parts.month), Number(parts.day));
  };
  // Smallest instant whose local day is >= the wanted one; local day never decreases with time.
  let low = midnight - 15 * 3_600_000;
  let high = midnight + 15 * 3_600_000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (localDay(middle) >= day) high = middle;
    else low = middle;
  }
  return high;
}
