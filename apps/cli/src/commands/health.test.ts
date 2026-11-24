import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { outputOptions } from '../output.ts';
import { readHealth } from './health.ts';

const API = 'http://nix.test';
const STATUS = { service: 'nix-api', version: '1.0.0', utcNow: '2026-10-09T12:30:00Z' };
const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(() => {
  server.close();
});

function capture() {
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  });
  return lines;
}

function healthy() {
  server.use(
    http.get(`${API}/healthz`, () => HttpResponse.json({ status: 'healthy' })),
    http.get(`${API}/api/v1/health/status`, () => HttpResponse.json(STATUS)),
  );
}

describe('public Core health', () => {
  it('reports real liveness and identity without credentials or a token exchange', async () => {
    vi.stubEnv('NIX_SESSION_TOKEN', 'must-not-be-sent');
    vi.stubEnv('NIX_API_URL', 'http://must-not-be-used.test');
    const requested: string[] = [];
    server.use(
      http.get(`${API}/healthz`, ({ request }) => {
        expect(request.headers.has('authorization')).toBe(false);
        expect(request.headers.has('cookie')).toBe(false);
        requested.push(new URL(request.url).pathname);
        return HttpResponse.json({ status: 'healthy' });
      }),
      http.get(`${API}/api/v1/health/status`, ({ request }) => {
        expect(request.headers.has('authorization')).toBe(false);
        requested.push(new URL(request.url).pathname);
        return HttpResponse.json(STATUS);
      }),
    );
    const lines = capture();
    await readHealth(`${API}/`, outputOptions(true));
    expect(JSON.parse(lines.join(''))).toEqual({
      apiUrl: API,
      liveness: 'healthy',
      ...STATUS,
      dependenciesChecked: false,
    });
    expect(requested.sort()).toEqual(['/api/v1/health/status', '/healthz']);
  });

  it('surfaces an HTTP refusal and prints no success result', async () => {
    healthy();
    server.use(
      http.get(`${API}/healthz`, () =>
        HttpResponse.json(
          {
            title: 'Unavailable',
            status: 503,
            detail: 'Core is restarting.',
            code: 'test.unavailable',
          },
          { status: 503, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );
    const lines = capture();
    await expect(readHealth(API, outputOptions(true))).rejects.toMatchObject({
      status: 503,
      code: 'test.unavailable',
    });
    expect(lines).toEqual([]);
  });

  it.each([
    { ...STATUS, utcNow: 'not-a-server-clock' },
    { ...STATUS, service: 'another-app' },
  ])('refuses a non-Core response rather than reporting a false success: %j', async (status) => {
    healthy();
    server.use(http.get(`${API}/api/v1/health/status`, () => HttpResponse.json(status)));
    const lines = capture();
    await expect(readHealth(API, outputOptions(true))).rejects.toThrow();
    expect(lines).toEqual([]);
  });

  it.each([
    'file:///tmp/core',
    'http://user:secret@nix.test',
    `${API}/api`,
    `${API}?token=secret`,
    `${API}#fragment`,
  ])('refuses invalid or credential-bearing origins before I/O: %s', async (origin) => {
    await expect(readHealth(origin, outputOptions(true))).rejects.toThrow(/HTTP\(S\) origin/);
  });

  it('fails the opted-in session check when liveness is healthy but the session endpoint fails', async () => {
    healthy();
    server.use(
      http.get(`${API}/auth/session`, () =>
        HttpResponse.json({ detail: 'must-not-print-session-secret' }, { status: 500 }),
      ),
    );
    const lines = capture();
    await expect(readHealth(API, outputOptions(true), undefined, true)).rejects.toThrow(
      'The browser-session endpoint returned HTTP 500.',
    );
    expect(lines).toEqual([]);
  });

  it('checks the session anonymously and prints only availability rather than session data', async () => {
    healthy();
    vi.stubEnv('NIX_SESSION_TOKEN', 'must-not-send-token');
    server.use(
      http.get(`${API}/auth/session`, ({ request }) => {
        expect(request.headers.has('authorization')).toBe(false);
        expect(request.headers.has('cookie')).toBe(false);
        return HttpResponse.json({
          authenticated: false,
          configured: true,
          profile: { name: 'must-not-print-profile' },
          accessToken: 'must-not-print-token',
        });
      }),
    );
    const lines = capture();
    await readHealth(API, outputOptions(true), undefined, true);
    expect(JSON.parse(lines.join(''))).toEqual({
      apiUrl: API,
      liveness: 'healthy',
      ...STATUS,
      dependenciesChecked: false,
      browserSession: 'available',
    });
    expect(lines.join('')).not.toContain('must-not-');
  });

  it.each([
    HttpResponse.json({ authenticated: false }),
    HttpResponse.html('<html>must-not-print-page</html>'),
    new HttpResponse(JSON.stringify({ authenticated: false, configured: true }), {
      headers: { 'Content-Type': 'text/html' },
    }),
    new HttpResponse('{"authenticated":false,"configured":must-not-print-token}', {
      headers: { 'Content-Type': 'application/json' },
    }),
  ])('rejects an unexpected session response without exposing its body', async (response) => {
    healthy();
    server.use(http.get(`${API}/auth/session`, () => response));
    const lines = capture();
    await expect(readHealth(API, outputOptions(true), undefined, true)).rejects.toThrow(
      'The browser-session endpoint returned an unexpected response.',
    );
    expect(lines).toEqual([]);
  });

  it.each([`${API}/redirected`, 'http://another-host.test/redirected'])(
    'does not follow a session redirect to %s or report a successful check',
    async (destination) => {
      healthy();
      const redirected = vi.fn();
      server.use(
        http.get(`${API}/auth/session`, () => HttpResponse.redirect(destination, 302)),
        http.get(destination, () => {
          redirected();
          return HttpResponse.json({ authenticated: false, configured: true });
        }),
      );
      const lines = capture();
      await expect(readHealth(API, outputOptions(true), undefined, true)).rejects.toThrow(
        'The browser-session endpoint could not be reached.',
      );
      expect(redirected).not.toHaveBeenCalled();
      expect(lines).toEqual([]);
    },
  );

  it('does not print a success result when the session connection fails', async () => {
    healthy();
    server.use(http.get(`${API}/auth/session`, () => HttpResponse.error()));
    const lines = capture();
    await expect(readHealth(API, outputOptions(true), undefined, true)).rejects.toThrow(
      'The browser-session endpoint could not be reached.',
    );
    expect(lines).toEqual([]);
  });

  it('cancels the in-flight session check with the caller signal', async () => {
    healthy();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    server.use(
      http.get(`${API}/auth/session`, async ({ request }) => {
        markStarted?.();
        await new Promise<void>((resolve) => {
          request.signal.addEventListener(
            'abort',
            () => {
              resolve();
            },
            { once: true },
          );
        });
        return HttpResponse.json({ authenticated: false, configured: true });
      }),
    );
    const lines = capture();
    const abort = new AbortController();
    const result = readHealth(API, outputOptions(true), abort.signal, true);
    const rejected = expect(result).rejects.toThrow(
      'The browser-session endpoint could not be reached.',
    );
    await started;
    abort.abort();
    await rejected;
    expect(lines).toEqual([]);
  });

  it('cancels a probe through the API client', async () => {
    healthy();
    const abort = new AbortController();
    abort.abort();
    await expect(readHealth(API, outputOptions(true), abort.signal)).rejects.toMatchObject({
      kind: 'canceled',
    });
  });
});
