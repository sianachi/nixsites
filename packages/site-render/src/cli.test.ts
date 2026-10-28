import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { beforeAll, describe, expect, it } from 'vitest';

import { main } from './cli.js';
import { createPreviewServer, normalizePath, SITE_CSP } from './serve.js';

const fixture = join(import.meta.dirname, '__fixtures__', 'docs');

describe('nix-site-render', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'nix-site-')), 'site');
  beforeAll(async () => {
    expect(await main(['build', '--fixture', fixture, '--out', out])).toBe(0);
  });

  it('builds a fixture into a directory', async () => {
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toContain('<!doctype html>');
    expect(existsSync(join(out, '_nix', 'build.json'))).toBe(true);
    // A rebuild replaces its own previous output.
    expect(await main(['build', '--fixture', fixture, '--out', out])).toBe(0);
  });

  it('refuses to replace a directory that is not a site build', async () => {
    const out = mkdtempSync(join(tmpdir(), 'nix-site-'));
    writeFileSync(join(out, 'keep.txt'), 'mine');
    await expect(main(['build', '--fixture', fixture, '--out', out])).rejects.toThrow(/refusing/);
    expect(readFileSync(join(out, 'keep.txt'), 'utf8')).toBe('mine');
  });

  it('prints usage for anything else', async () => {
    expect(await main(['publish'])).toBe(2);
  });

  it.each(['/../etc/passwd', '/a/%2e%2e/b', '/a%2fb', '/a\\b', '/%00'])(
    'refuses the request path %s',
    (path) => {
      expect(normalizePath(path)).toBeNull();
    },
  );

  it('serves with the site headers, redirects, and the 404 page', async () => {
    const server = createPreviewServer(out).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    try {
      const home = await fetch(`${base}/`);
      expect(home.status).toBe(200);
      expect(home.headers.get('content-security-policy')).toBe(SITE_CSP);
      expect(home.headers.get('set-cookie')).toBeNull();
      const moved = await fetch(`${base}/install/`, { redirect: 'manual' });
      expect([moved.status, moved.headers.get('location')]).toEqual([
        308,
        '/getting-started/install/',
      ]);
      const slash = await fetch(`${base}/features`, { redirect: 'manual' });
      expect(slash.status).toBe(308);
      const missing = await fetch(`${base}/nope/`);
      expect(missing.status).toBe(404);
      expect(await missing.text()).toContain('This page is not here.');
      expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405);
    } finally {
      server.close();
    }
  });
});
