export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Go's len(s): UTF-8 bytes. JS string length is already Go's utf16Len. */
export function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** truncateUTF8 caps s at limit bytes, cutting back to a rune boundary. */
export function truncateUtf8(s: string, limit: number): string {
  const bytes = Buffer.from(s, 'utf8');
  if (bytes.length <= limit) return s;
  let cut = limit;
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut--;
  return bytes.subarray(0, cut).toString('utf8');
}

const HTML_ESCAPES: Record<string, string> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

/**
 * Go's json.Marshal: HTML-escaped, and a map's keys sorted. `sortKeys: false` keeps the first
 * level in insertion order, for the flat tool-argument struct whose field order is fixed.
 */
export function goJson(value: unknown, sortKeys = true): string {
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value) as string | undefined;
    return (text ?? 'null').replace(/[<>&\u2028\u2029]/g, (c) => HTML_ESCAPES[c] ?? c);
  }
  if (Array.isArray(value)) return `[${value.map((item) => goJson(item)).join(',')}]`;
  const keys = Object.keys(value);
  if (sortKeys) keys.sort();
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of keys) {
    if (record[key] === undefined) continue;
    parts.push(`${goJson(key)}:${goJson(record[key])}`);
  }
  return `{${parts.join(',')}}`;
}

/** Parses text as a JSON object (not an array, scalar or null); undefined otherwise. */
export function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function isJsonObject(raw: string): boolean {
  return raw !== '' && parseObject(raw) !== undefined;
}

/** Max nesting of '{' and '[' in raw, ignoring strings, without decoding the document. */
export function jsonDepth(raw: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  let escaped = false;
  for (const c of raw) {
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') {
      depth++;
      if (depth > max) max = depth;
    } else if (c === '}' || c === ']') depth--;
  }
  return max;
}

/** signal.aborted read through a call, so a check after an await is not narrowed away. */
export const aborted = (signal: AbortSignal): boolean => signal.aborted;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** Rejects when signal aborts; never resolves otherwise. */
export function abortion(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal === undefined) return;
    const fail = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
