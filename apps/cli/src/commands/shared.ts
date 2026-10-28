/**
 * What every command that talks to the workspace needs: the resolved profile, opened as a session.
 *
 * A command that cannot find its profile fails with a sentence naming what to do, not with a stack
 * trace or a request to a server it has no address for - the same failure whether no profile is
 * signed in at all or a named one does not exist.
 */

import type { Command } from 'commander';
import { resolveProfile } from '../config.ts';
import type { OutputOptions } from '../output.ts';
import { openSession, type FetchImpl, type Session } from '../session.ts';

/** The seams a command exposes for tests: a fetch to stub, and a config environment to redirect. */
export interface SessionDeps {
  readonly fetchImpl?: FetchImpl;
  readonly env?: NodeJS.ProcessEnv;
}

/** Runs a command body with the global profile and output shape, printing any failure. */
export type Act = (
  command: Command,
  body: (profile: string | undefined, output: OutputOptions) => Promise<void>,
) => Promise<void>;

/**
 * Resolves the named profile (or the default) and opens a session for it.
 *
 * @throws When there is no such profile - the message names the fix.
 */
export async function resolveSession(
  profileName: string | undefined,
  deps: SessionDeps = {},
): Promise<Session> {
  const env = deps.env ?? process.env;
  if (profileName === undefined && env.NIX_SESSION_TOKEN && env.NIX_API_URL) {
    return openSession({
      profile: { apiUrl: env.NIX_API_URL, token: '' },
      bearerToken: env.NIX_SESSION_TOKEN,
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    });
  }
  const resolved = await resolveProfile(profileName, env);
  if (resolved === null) {
    throw new Error(
      profileName === undefined
        ? 'No profile is signed in. Run `nixctl auth login` first.'
        : `No profile called '${profileName}'. Run \`nixctl auth login --profile ${profileName}\`.`,
    );
  }

  return openSession({
    profile: resolved.profile,
    ...(env.NIX_SESSION_TOKEN === undefined ? {} : { bearerToken: env.NIX_SESSION_TOKEN }),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
}

/**
 * Mints the access token a command needs to speak to the collaboration service directly (as `note`
 * and `history` do), rather than through the Core client that mints its own.
 *
 * @throws When the profile's token cannot be exchanged for a session.
 */
export async function requireAccessToken(session: Session): Promise<string> {
  const token = await session.tokens.getAccessToken();
  if (token === null) {
    throw new Error('Could not obtain a session for this profile.');
  }
  return token;
}

export function assertConfirmed(confirmed: boolean): void {
  if (!confirmed) {
    throw new Error('This destructive operation requires --yes.');
  }
}

/** Reads all of stdin as UTF-8, for commands that take their input piped in. */
export async function readStdin(maxBytes?: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk as Buffer);
    total += bytes.byteLength;
    if (maxBytes !== undefined && total > maxBytes) {
      throw new RangeError(`Standard input exceeds ${String(maxBytes)} bytes.`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Checks an IANA zone name against the zones this runtime knows; Core still has the last word. */
export function parseTimeZone(value: string, flag: string): string {
  const zone = value.trim();
  if (zone === '') throw new Error(`${flag} cannot be empty.`);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    throw new Error(`${flag} must be an IANA time zone such as Europe/London - got '${value}'.`);
  }
  return zone;
}

export function parseTimeOfDay(value: string, flag: string): string {
  if (!TIME_OF_DAY.test(value)) throw new Error(`${flag} must be HH:mm - got '${value}'.`);
  return value;
}

export function parseUuid(value: string, flag: string): string {
  if (!UUID.test(value)) throw new Error(`${flag} must be a UUID - got '${value}'.`);
  return value.toLowerCase();
}
