import { createHash } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import { deliverCallback, external, launch, newProfile, sql, store } from './harness.mjs';

// The real app against a fake server: what the unit tests' injected fetch and direct calls cannot
// show (contextBridge, real frames, Electron's own fetch and navigation events). No sign-in needed.

const profile = newProfile();
const seen = [];
const server = createServer((req, res) => {
  seen.push({ url: req.url, cookie: req.headers.cookie ?? null });
  if (req.url === '/auth/session') {
    res.setHeader('content-type', 'application/json');
    return res.end('{"configured":true}');
  }
  if (req.url === '/blob') {
    res.statusCode = 302;
    res.setHeader('location', '/blob2');
    return res.end();
  }
  if (req.url === '/blob2') return res.end('payload-bytes');
  if (req.url === '/off-https') {
    res.statusCode = 302;
    res.setHeader('location', 'http://example.invalid/x');
    return res.end();
  }
  if (req.url === '/sandboxed') {
    res.setHeader('content-type', 'text/html');
    res.setHeader('content-security-policy', 'sandbox allow-scripts');
    return res.end('<!doctype html><title>sandboxed</title>');
  }
  if (req.url === '/denied') {
    res.statusCode = 403;
    return res.end('no');
  }
  res.setHeader('content-type', 'text/html');
  res.setHeader('set-cookie', 'session=secret; Path=/');
  res.end(
    `<!doctype html><title>fake</title><h1>fake server</h1>${req.url === '/' ? '<iframe id=f src="/frame"></iframe>' : ''}`,
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const origin = `http://localhost:${port}`;
const other = `http://other.localhost:${port}`;
let failures = 0;
const check = async (name, work) => {
  try {
    await work();
    console.log('✔', name);
  } catch (e) {
    failures += 1;
    console.log(
      '✖',
      name,
      '\n   ',
      String(e.message).split('\n').slice(0, 4).join(' | ').slice(0, 400),
    );
  }
};
const { app, page } = await launch(profile);
await page.fill('#address', origin);
await page.click('button[type=submit]');
await page.waitForURL(`${origin}/`);
const caught = (fn, arg) =>
  page.evaluate(
    async ([src, a]) => {
      try {
        return { ok: await eval(src)(a) };
      } catch (e) {
        return { type: typeof e, text: String(e), isError: e instanceof Error };
      }
    },
    [fn, arg],
  );

await check('store round trip through contextBridge: rows, blob, tx', async () => {
  await sql(page, 'CREATE TABLE t(a, b)');
  const { tx } = await store(page, { op: 'begin' });
  await store(page, {
    op: 'execute',
    sql: 'INSERT INTO t VALUES (?, ?)',
    params: [7, { $b64: 'AQID' }],
    tx,
  });
  await store(page, { op: 'commit', tx });
  assert.deepEqual(await sql(page, 'SELECT a, b FROM t'), [{ a: 7, b: { $b64: 'AQID' } }]);
});
await check('a store error rejects with a plain string, as WebKit does', async () => {
  const r = await caught('(r) => window.webkit.messageHandlers.nixStore.postMessage(r)', {
    op: 'execute',
    sql: "ATTACH ':memory:' AS x",
  });
  assert.equal(r.type, 'string');
  assert.match(r.text, /not authorized/);
});
await check('real download: follows redirect by hand, no cookies sent, digest right', async () => {
  seen.length = 0;
  const got = await store(page, { op: 'fileDownload', key: 'k1', url: `${origin}/blob` });
  assert.deepEqual(got, {
    bytes: 13,
    sha256: createHash('sha256').update('payload-bytes').digest('hex'),
  });
  assert.deepEqual(
    seen.map((s) => s.url),
    ['/blob', '/blob2'],
  );
  assert.ok(
    seen.every((s) => s.cookie === null),
    JSON.stringify(seen),
  );
  assert.equal(
    Buffer.from((await store(page, { op: 'fileGet', key: 'k1' })).data, 'base64').toString(),
    'payload-bytes',
  );
});
await check('real download: redirect off to plain http refused; 403 refused', async () => {
  const r = await caught('(r) => window.webkit.messageHandlers.nixStore.postMessage(r)', {
    op: 'fileDownload',
    key: 'k2',
    url: `${origin}/off-https`,
  });
  assert.match(r.text, /must use https/);
  const d = await caught('(r) => window.webkit.messageHandlers.nixStore.postMessage(r)', {
    op: 'fileDownload',
    key: 'k3',
    url: `${origin}/denied`,
  });
  assert.match(d.text, /failed/);
});
await check('keepAwake and notify answer', async () => {
  for (const r of [
    { op: 'keepAwake', running: true },
    { op: 'keepAwake', running: false },
    { op: 'notify' },
    { op: 'notify', title: 't', body: 'b' },
  ])
    assert.deepEqual(await store(page, r), {});
});
await check('an iframe gets no bridge, and the page no Node or picker', async () => {
  const f = page.frames().find((x) => x.url().endsWith('/frame'));
  assert.ok(f);
  assert.deepEqual(
    await f.evaluate(() => [typeof window.webkit, typeof window.Capacitor, typeof window.require]),
    ['undefined', 'undefined', 'undefined'],
  );
  assert.deepEqual(
    await page.evaluate(() => [
      typeof window.nixPicker,
      typeof window.require,
      typeof window.process,
      typeof window.electron,
    ]),
    ['undefined', 'undefined', 'undefined', 'undefined'],
  );
});
// Past the one-a-second limit on opening the browser.
const pastRateLimit = () => page.waitForTimeout(1100);
await check('navigating away and window.open go to the browser; the window stays', async () => {
  const before = (await external(app)).length;
  await pastRateLimit();
  await page.evaluate(() => {
    window.location.href = 'https://evil.example/';
  });
  await pastRateLimit();
  await page.evaluate(() => {
    window.open('https://evil.example/popup');
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.open('file:///etc/passwd');
    window.open('javascript:alert(1)');
  });
  await page.waitForTimeout(300);
  assert.deepEqual((await external(app)).slice(before), [
    'https://evil.example/',
    'https://evil.example/popup',
  ]);
  assert.equal(page.url(), `${origin}/`);
  assert.equal(app.windows().length, 1);
});
await check('a page cannot open a run of browser tabs', async () => {
  await pastRateLimit();
  const before = (await external(app)).length;
  await page.evaluate(() => {
    for (let i = 0; i < 5; i += 1) window.open(`https://evil.example/${i}`);
  });
  await page.waitForTimeout(300);
  assert.equal((await external(app)).length - before, 1);
});
await check('a redirect out of the saved server is stopped', async () => {
  await pastRateLimit();
  const before = (await external(app)).length;
  await page.evaluate((o) => {
    window.location.href = `${o}/off-https`;
  }, origin);
  await page.waitForTimeout(800);
  assert.deepEqual((await external(app)).slice(before), ['http://example.invalid/x']);
});
await check(
  'permissions: microphone, geolocation and clipboard read refused, clipboard write allowed',
  async () => {
    await page.goto(`${origin}/`).catch(() => undefined);
    const media = await page.evaluate(async () => {
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        return 'granted';
      } catch (e) {
        return e.name;
      }
    });
    assert.notEqual(media, 'granted');
    const geo = await page.evaluate(
      () =>
        new Promise((r) =>
          navigator.geolocation.getCurrentPosition(
            () => r('granted'),
            (e) => r(e.code),
            { timeout: 2000 },
          ),
        ),
    );
    assert.notEqual(geo, 'granted');
    const state = await page.evaluate(
      async () => (await navigator.permissions.query({ name: 'clipboard-write' })).state,
    );
    assert.equal(state, 'granted');
    const read = await page.evaluate(() =>
      navigator.clipboard.readText().then(
        () => 'granted',
        (e) => e.name,
      ),
    );
    assert.equal(read, 'NotAllowedError');
  },
);
const signInCall = (returnTo) =>
  page.evaluate((r) => {
    window.__si = window.webkit.messageHandlers.nixSignIn.postMessage({ returnTo: r }).then(
      (v) => ({ value: v }),
      (e) => ({ type: typeof e, text: String(e) }),
    );
  }, returnTo);
const signInResult = () => page.evaluate(() => window.__si);
const emitCallback = (url) => deliverCallback(app, url);
const lastExternal = async () => (await external(app)).at(-1);
const callbackFrom = (issuer, code) =>
  `app.nix.shell://auth?code=${code}&iss=${encodeURIComponent(issuer)}`;
await check(
  'sign-in: unsafe returnTo dropped; bad callbacks ignored; good one gives code and the matching verifier',
  async () => {
    await pastRateLimit();
    await signInCall('//evil.example/');
    await page.waitForTimeout(200);
    const url = new URL(await lastExternal());
    assert.equal(url.origin + url.pathname, `${origin}/auth/login`);
    assert.equal(url.searchParams.get('returnTo'), '/');
    for (const bad of [
      'app.nix.shell://other?code=x',
      'app.nix.shell://auth?code=x&y=1',
      'https://auth?code=x',
      'app.nix.shell://auth',
      'app.nix.shell://auth?code=no-issuer',
      // The mix-up attack: another server's code, reached by redirecting the browser there.
      callbackFrom('https://victim.example', 'stolen'),
    ])
      await emitCallback(bad);
    await page.waitForTimeout(200);
    const pending = await page.evaluate(() =>
      Promise.race([window.__si, new Promise((r) => setTimeout(() => r('pending'), 100))]),
    );
    assert.equal(pending, 'pending');
    await emitCallback(callbackFrom(origin, 'the-code'));
    const { value } = await signInResult();
    assert.equal(value.code, 'the-code');
    assert.equal(
      createHash('sha256').update(value.verifier).digest('base64url'),
      url.searchParams.get('native'),
    );
  },
);
await check('sign-in: a callback with nothing waiting is dropped', async () => {
  await emitCallback(callbackFrom(origin, 'stray'));
});
await check(
  "sign-in: a new attempt ends the old one with the exact string 'cancelled'",
  async () => {
    await pastRateLimit();
    await signInCall('/a');
    await page.evaluate(() => {
      window.__first = window.__si;
    });
    await pastRateLimit();
    await signInCall('/b');
    assert.deepEqual(await page.evaluate(() => window.__first), {
      type: 'string',
      text: 'cancelled',
    });
    await emitCallback(callbackFrom(origin, 'c'));
    assert.equal((await signInResult()).value.code, 'c');
  },
);
await check(
  'sign-in: coming back to the window with no callback cancels after the grace period',
  async () => {
    await pastRateLimit();
    await signInCall('/a');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].emit('focus');
    });
    await page.waitForTimeout(5500);
    assert.deepEqual(await signInResult(), { type: 'string', text: 'cancelled' });
  },
);
await check('a saved page that drops its own origin (sandboxed) gets refusals', async () => {
  await page.goto(`${origin}/sandboxed`);
  for (const channel of ['nixStore', 'nixSignIn']) {
    const r = await caught(`(r) => window.webkit.messageHandlers.${channel}.postMessage(r)`, {
      op: 'usage',
    });
    assert.equal(r.text, 'Not allowed.', channel);
  }
  const s = await caught("() => window.Capacitor.nativePromise('NixShell', 'showPicker')");
  assert.equal(s.text, 'Not allowed.');
});
await check(
  'a runaway query cannot freeze the app; the store comes back with its data',
  async () => {
    await page.goto(`${origin}/`);
    const started = Date.now();
    const runaway = caught('(r) => window.webkit.messageHandlers.nixStore.postMessage(r)', {
      op: 'execute',
      sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c',
    });
    await page.waitForTimeout(3000);
    const beforeMain = Date.now();
    await app.evaluate(() => 1);
    await store(page, { op: 'usage' });
    assert.ok(Date.now() - beforeMain < 1000, 'the main process stayed responsive');
    const { text } = await runaway;
    assert.match(text, /stopped responding/);
    console.log(`  (killed after ${Math.round((Date.now() - started) / 1000)}s)`);
    assert.deepEqual(await sql(page, 'SELECT a FROM t'), [{ a: 7 }]);
  },
);
await check('a page that leaves the saved servers is sent back to the picker', async () => {
  for (const url of [`${other}/plain`, 'about:blank']) {
    await app.evaluate(({ BrowserWindow }, target) => {
      void BrowserWindow.getAllWindows()[0]
        .loadURL(target)
        .catch(() => undefined);
    }, url);
    await page.waitForTimeout(1000);
    assert.match(page.url(), /picker\/index\.html/, url);
  }
});
await check('Switch server opens the picker, which lists the server', async () => {
  await app.evaluate(
    ({ BrowserWindow }, u) => BrowserWindow.getAllWindows()[0].loadURL(u),
    `${origin}/`,
  );
  await page.waitForURL(`${origin}/`);
  await page.evaluate(() => {
    void window.Capacitor.nativePromise('NixShell', 'showPicker');
  });
  await page.waitForURL(/picker\/index\.html/);
  await page.waitForSelector('li .open');
  assert.equal(await page.textContent('li .open'), `localhost:${port}`);
  assert.deepEqual(await page.evaluate(() => [typeof window.webkit, typeof window.Capacitor]), [
    'undefined',
    'undefined',
  ]);
});
await check('the picker cannot open an unsaved origin', async () => {
  const r = await page.evaluate(() =>
    window.nixPicker({ op: 'open', origin: 'https://evil.example' }).catch((e) => e),
  );
  assert.equal(r, 'Unknown server.');
});
await check('a server that stops answering lands on the picker with a reason', async () => {
  await page.evaluate(() => document.querySelector('li .open').click());
  await page.waitForURL(`${origin}/`);
  await new Promise((r) => {
    server.closeAllConnections();
    server.close(r);
  });
  await page.reload().catch(() => undefined);
  await page.waitForURL(/picker\/index\.html/, { timeout: 8000 });
  await page.waitForFunction(() =>
    /Could not open/.test(document.getElementById('status').textContent),
  );
});
await check(
  'removing a server deletes its store and files, and it is no longer admitted',
  async () => {
    const dir = join(profile, 'nix-store');
    assert.ok(readdirSync(dir).some((n) => n.endsWith('.sqlite')));
    await page.click('li button[aria-label^=Remove]');
    await page.waitForFunction(() => /Removed/.test(document.getElementById('status').textContent));
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(await page.locator('li').count(), 0);
  },
);
await app.close();
rmSync(profile, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL PASSED' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
