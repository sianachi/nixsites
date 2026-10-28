import type { AccessToken } from './use-access-tokens';

/**
 * The facts the settings screen states about a token, computed in one place so the table, the
 * revoke dialog and the tests all agree on what "live" means.
 *
 * No React in here: these are sentences about data, and the components render them. The type
 * import from the hook module is a type alone, so this module stays runtime-free.
 */

export type TokenStatus =
  | { readonly kind: 'live' }
  | { readonly kind: 'revoked'; readonly at: string }
  | { readonly kind: 'expired'; readonly at: string };

/**
 * What state a token is in right now.
 *
 * Revocation wins over expiry: a token that was revoked and has since also aged past its expiry
 * is reported as revoked, because the revocation is the deliberate act - the fact a reader
 * auditing the list wants first - and the expiry would have happened regardless.
 *
 * Expiry is computed here, client-side, because the server does not send a flag for it: it sends
 * the timestamp, and whether that timestamp is past depends on when you ask.
 */
export function tokenStatus(token: AccessToken, now: Date): TokenStatus {
  if (token.revokedAt !== null) {
    return { kind: 'revoked', at: token.revokedAt };
  }

  if (Date.parse(token.expiresAt) < now.getTime()) {
    return { kind: 'expired', at: token.expiresAt };
  }

  return { kind: 'live' };
}

/**
 * A timestamp as the calendar day it names, `yyyy-MM-dd`.
 *
 * en-CA is the one locale trick this module allows itself, the same one `readerToday` in
 * `views/query/use-query-results.ts` documents: it formats exactly this shape, and the
 * alternative is hand-assembling parts. Deliberately not the reader's locale: these are audit
 * facts, and an unambiguous sortable date serves an audit better than a pretty one.
 */
export function formatDay(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    // An unparseable timestamp is shown as itself rather than as "Invalid Date": the raw value is
    // at least evidence, and hiding it would hide the defect.
    return iso;
  }

  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(parsed);
}
