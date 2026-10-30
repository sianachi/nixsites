import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { Profile } from './config.ts';
import type { FetchImpl } from './session.ts';

const expiry = z.iso.datetime({ offset: true });
export const cliTokenSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: expiry,
  sessionExpiresAt: expiry,
});
export const cliStartSchema = z.object({
  deviceCode: z.string().startsWith('nixclidevice_'),
  userCode: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[A-Z0-9-]+$/),
  verificationUri: z.url(),
  expiresAt: expiry,
  intervalSeconds: z.number().int().min(1).max(30),
});
export const cliPollSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('denied') }),
  z.object({ status: z.literal('expired') }),
  cliTokenSchema.extend({
    status: z.literal('approved'),
    refreshToken: z.string().startsWith('nixcli_'),
  }),
]);

export interface CliAuthDeps {
  readonly fetchImpl?: FetchImpl;
  readonly signal?: AbortSignal;
}

export class CliAuthRateLimitError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfter: string | null) {
    const seconds = retryAfter === null ? 5 : Number(retryAfter);
    const retryAfterSeconds =
      Number.isFinite(seconds) && seconds > 0 ? Math.min(60, Math.ceil(seconds)) : 5;
    super(
      `Core temporarily rate limited CLI authentication. Retry in ${String(retryAfterSeconds)} seconds.`,
    );
    this.name = 'CliAuthRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Credentials only travel to HTTPS Core or a local loopback service, without redirects. */
export function trustedCoreUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Core URL must be an HTTPS origin or local loopback HTTP origin.');
  }
  if (!isSafeOrigin(url) || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('Core URL must be an HTTPS origin or local loopback HTTP origin.');
  }
  return url.origin;
}

/** A server response cannot silently select another login site for the browser. */
export function trustedVerificationUrl(
  value: string,
  apiUrl: string,
  browserUrl?: string,
  userCode?: string,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Core returned an invalid browser login URL.');
  }
  const core = new URL(trustedCoreUrl(apiUrl));
  const expected = browserUrl === undefined ? core : new URL(trustedCoreUrl(browserUrl));
  if (
    !isSafeOrigin(url) ||
    url.hash !== '' ||
    url.origin !== expected.origin ||
    url.pathname !== '/auth/cli' ||
    url.searchParams.size !== 1 ||
    !/^[A-Z0-9-]{1,32}$/.test(url.searchParams.get('user_code') ?? '') ||
    (userCode !== undefined && url.searchParams.get('user_code') !== userCode)
  ) {
    throw new Error(
      'Core returned a browser login URL outside the trusted origin. Set --browser-url to the Nix web origin if it differs from Core.',
    );
  }
  return url.href;
}

// Duplicated with apps/sites/src/shared/object-transfer.ts: the CLI and the sites app share no package.
function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function isSafeOrigin(url: URL): boolean {
  return (
    url.username === '' &&
    url.password === '' &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname)))
  );
}

/** Auth failures never print response bodies, request URLs, or credential-bearing transport errors. */
export async function cliAuthRequest<T>(
  apiUrl: string,
  path: '/auth/cli/start' | '/auth/cli/poll' | '/auth/cli/token',
  body: unknown,
  schema: z.ZodType<T>,
  deps: CliAuthDeps = {},
): Promise<T> {
  const origin = trustedCoreUrl(apiUrl);
  try {
    const response = await (deps.fetchImpl ?? globalThis.fetch)(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: authSignal(deps.signal),
    });
    if (response.status === 429)
      throw new CliAuthRateLimitError(response.headers.get('retry-after'));
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new Error('Invalid response');
    return parsed.data;
  } catch (cause) {
    if (deps.signal?.aborted) throw new Error('CLI login was cancelled.');
    if (cause instanceof CliAuthRateLimitError) throw cause;
    throw new Error(
      'Core could not complete CLI authentication. Run `nixctl auth login` again if the session expired or was revoked.',
    );
  }
}

export async function revokeCliSession(profile: Profile, deps: CliAuthDeps = {}): Promise<void> {
  if (profile.interactiveSession === undefined) return;
  const origin = trustedCoreUrl(profile.apiUrl);
  try {
    const response = await (deps.fetchImpl ?? globalThis.fetch)(`${origin}/auth/cli/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: profile.interactiveSession.refreshToken }),
      redirect: 'error',
      signal: authSignal(deps.signal),
    });
    if (!response.ok) throw new Error('Logout failed');
  } catch {
    throw new Error(
      'Core could not revoke this CLI session. The local profile was retained; retry `nixctl auth logout`.',
    );
  }
}

function authSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(10_000);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/** Argument arrays and shell:false prevent a login URL from becoming shell syntax. */
export async function openLoginBrowser(url: string): Promise<void> {
  const [command, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: 'ignore', timeout: 10_000 });
    child.once('error', () => {
      reject(new Error('Could not open the browser.'));
    });
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error('Could not open the browser.'));
    });
  });
}
