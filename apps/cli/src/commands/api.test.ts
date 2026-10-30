import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { callApi, listApiOperations } from './api.ts';
import { outputOptions } from '../output.ts';
import { captureJson, makeProfile } from './cli.test-helper.ts';

const API = 'http://nix.test';
const ITEM = '11111111-1111-4111-8111-111111111111';

const server = setupServer(
  http.post(`${API}/public/v1/auth/token`, () =>
    HttpResponse.json({ accessToken: 'jwt-1', tokenType: 'Bearer', expiresInSeconds: 600 }),
  ),
);
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

describe('nixctl api', () => {
  it('lists the best matches for a filter, with the risk of each', async () => {
    const printed = (await captureJson((json) => {
      listApiOperations(['purge', 'item'], json);
      return Promise.resolve();
    })) as { operations: { id: string; risk: string | null }[] };
    expect(printed.operations.length).toBeGreaterThan(0);
    expect(printed.operations.find((entry) => entry.id === 'PurgeItem')?.risk).toBe('irreversible');
  });

  it('runs an operation with path, typed query values and a body', async () => {
    const { env, done } = await makeProfile({ apiUrl: API, token: 'nixpat_abc' });
    let seen: { method: string; url: string; body: unknown } | undefined;
    server.use(
      http.post(`${API}/api/v1/items/:itemId/move`, async ({ request }) => {
        seen = { method: request.method, url: request.url, body: await request.json() };
        return HttpResponse.json({ moved: true });
      }),
    );
    const printed = await captureJson((json) =>
      callApi(
        'default',
        'MoveItem',
        { param: [`itemId=${ITEM}`], body: '{"parentId":null,"afterId":null}' },
        json,
        { env },
      ),
    );
    expect(printed).toEqual({ moved: true });
    expect(seen?.url).toBe(`${API}/api/v1/items/${ITEM}/move`);
    expect(seen?.body).toEqual({ parentId: null, afterId: null });
    await done();
  });

  it('says what is wrong with a malformed body or pair', async () => {
    const { env, done } = await makeProfile({ apiUrl: API, token: 'nixpat_abc' });
    await expect(
      callApi('default', 'MoveItem', { body: '{nope' }, outputOptions(true), { env }),
    ).rejects.toThrow(/valid JSON/);
    await expect(
      callApi('default', 'MoveItem', { param: ['itemId'] }, outputOptions(true), { env }),
    ).rejects.toThrow(/key=value/);
    await done();
  });
});
