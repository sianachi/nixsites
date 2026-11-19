// From Sani guard.ts at 2396a9b6b6532fd33a822ba30a74d4b53f4bab90 (MIT; see adjacent LICENSE).
function fragments(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(fragments);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => [key, ...fragments(entry)]);
  }
  return [];
}

export function assertScreened(value: unknown, secrets: readonly string[]): void {
  const json: unknown = JSON.stringify(value);
  if (typeof json !== 'string' || Buffer.byteLength(json) > 64 * 1024) {
    throw new Error('The data exceeded the size limit.');
  }
  const joined = fragments(value).join('');
  for (const secret of secrets) {
    if (!secret) continue;
    const variants = new Set([
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret).toString('base64'),
      Buffer.from(secret).toString('base64url'),
    ]);
    for (const variant of variants) {
      if (json.includes(variant) || joined.includes(variant)) {
        throw new Error('Sani withheld data containing a connection credential.');
      }
    }
  }
}
