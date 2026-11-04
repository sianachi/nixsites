import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import webConfig, {
  contentSecurityPolicy,
  parseObjectStorePublicOrigin,
} from '../apps/web/vite.config.ts';

const repo = new URL('../', import.meta.url);

test('accepts one exact safe object-store origin and refuses ambiguous values', () => {
  assert.equal(
    parseObjectStorePublicOrigin('https://objects.example.test:9443/'),
    'https://objects.example.test:9443',
  );
  assert.equal(parseObjectStorePublicOrigin('http://127.0.0.1:7070'), 'http://127.0.0.1:7070');

  for (const value of [
    '',
    ' https://objects.example.test',
    'http://objects.example.test',
    'ftp://objects.example.test',
    'https://user@objects.example.test',
    'https://objects.example.test/storage',
    'https://objects.example.test?mode=public',
    'https://objects.example.test#public',
    'https://one.example.test https://two.example.test',
  ]) {
    assert.throws(() => parseObjectStorePublicOrigin(value));
  }
});

test('the browser CSP admits only self and the configured object-store connection origin', () => {
  const policy = contentSecurityPolicy('https://objects.example.test:9443');
  const connectSource = policy
    .split(';')
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith('connect-src '));

  assert.equal(connectSource, "connect-src 'self' https://objects.example.test:9443");
  assert.doesNotMatch(connectSource ?? '', /(?:^|\s)(?:https:|http:|\*)($|\s)/u);
});

test('Vite removes the fail-closed meta fallback and serves the configured CSP as a header', async () => {
  const html = await readFile(new URL('apps/web/index.html', repo), 'utf8');
  const plugin = webConfig.plugins?.find(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      'name' in candidate &&
      candidate.name === 'nix-configured-content-security-policy',
  );
  assert.ok(plugin !== undefined && typeof plugin === 'object');
  assert.ok('transformIndexHtml' in plugin && typeof plugin.transformIndexHtml === 'function');

  const transformed = plugin.transformIndexHtml(html);
  assert.equal(typeof transformed, 'string');
  assert.doesNotMatch(String(transformed), /http-equiv="Content-Security-Policy"/u);

  const expected = contentSecurityPolicy('http://localhost:7070');
  const developmentExpected = expected.replace(
    /script-src 'self' [^;]+/u,
    "script-src 'self' 'unsafe-inline'",
  );
  assert.equal(webConfig.server?.headers?.['Content-Security-Policy'], developmentExpected);
  assert.equal(webConfig.preview?.headers?.['Content-Security-Policy'], expected);
});

test('Caddy policies use the exact configured origin placeholder', async () => {
  for (const path of ['deploy/Caddyfile', 'deploy/Caddyfile.prod', 'deploy/k8s/Caddyfile']) {
    const caddyfile = await readFile(new URL(path, repo), 'utf8');
    const policy = /Content-Security-Policy "([^"]+)"/u.exec(caddyfile)?.[1];
    assert.ok(policy !== undefined, `${path} has no CSP header`);
    const connectSource = policy
      .split(';')
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith('connect-src '));

    assert.equal(
      connectSource,
      "connect-src 'self' {$NIX_OBJECT_STORE_PUBLIC_ORIGIN}",
      `${path} must admit only the configured object-store origin`,
    );
  }
});

test('production Compose gives Core, workers, and Caddy one public-origin contract', async () => {
  const compose = await readFile(new URL('deploy/compose.prod.yml', repo), 'utf8');

  assert.match(
    compose,
    /Nix__ObjectStorage__PublicOrigin: \$\{NIX_OBJECT_STORE_PUBLIC_ORIGIN:\?set NIX_OBJECT_STORE_PUBLIC_ORIGIN\}/u,
  );
  assert.match(
    compose,
    /NIX_OBJECT_STORE_PUBLIC_ORIGIN: \$\{NIX_OBJECT_STORE_PUBLIC_ORIGIN:\?set NIX_OBJECT_STORE_PUBLIC_ORIGIN\}/u,
  );
  assert.equal(
    [
      ...compose.matchAll(
        /NIX_WORKER_OBJECT_ORIGINS: \$\{NIX_OBJECT_STORE_ENDPOINT:\?set NIX_OBJECT_STORE_ENDPOINT\},\$\{NIX_OBJECT_STORE_PUBLIC_ORIGIN:\?set NIX_OBJECT_STORE_PUBLIC_ORIGIN\}/gu,
      ),
    ].length,
    // Every job runs inside Core now, so no worker container reads the object origins.
    0,
  );
});
