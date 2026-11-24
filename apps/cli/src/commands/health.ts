import { createNixClient, health } from '@nix/api-client';
import { z } from 'zod';
import { printResult, type OutputOptions } from '../output.ts';

function coreOrigin(value: string): string {
  const message =
    '--api-url must be an HTTP(S) origin without credentials, a path, query or fragment.';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(message);
  }
  if (
    value !== value.trim() ||
    value.length > 2048 ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  )
    throw new Error(message);
  return url.origin;
}

const browserSessionSchema = z.object({ authenticated: z.boolean(), configured: z.boolean() });

async function checkBrowserSession(origin: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(new URL('/auth/session', origin), {
    credentials: 'omit',
    redirect: 'error',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(5000)]),
  }).catch(() => {
    throw new Error('The browser-session endpoint could not be reached.');
  });
  if (!response.ok)
    throw new Error(`The browser-session endpoint returned HTTP ${String(response.status)}.`);
  const parsed = await response
    .json()
    .then((value: unknown) => browserSessionSchema.safeParse(value))
    .catch(() => null);
  if (
    response.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json' ||
    !parsed?.success
  )
    throw new Error('The browser-session endpoint returned an unexpected response.');
}

/** Probes public Core routes without reading a profile or acquiring any credentials. */
export async function readHealth(
  apiUrl: string,
  output: OutputOptions,
  signal?: AbortSignal,
  checkSession = false,
): Promise<void> {
  const origin = coreOrigin(apiUrl);
  const client = createNixClient({
    baseUrl: origin,
    timeoutMs: 5000,
    tokens: {
      getAccessToken: () => null,
      refreshAccessToken: () => Promise.resolve(null),
    },
  });
  const [alive, status] = await Promise.all([
    client.query(health.liveness(), { forceRefresh: true, signal }),
    client.query(health.serviceStatus(), { forceRefresh: true, signal }),
  ]);
  if (checkSession) await checkBrowserSession(origin, signal);
  printResult(
    {
      apiUrl: origin,
      liveness: alive.status,
      ...status,
      dependenciesChecked: false,
      ...(checkSession ? { browserSession: 'available' } : {}),
    },
    output,
  );
}
