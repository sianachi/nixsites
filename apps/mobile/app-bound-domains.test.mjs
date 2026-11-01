import assert from 'node:assert/strict';
import { test } from 'node:test';

import { boundDomains } from './scripts/app-bound-domains.mjs';

test('hosts are listed after localhost, without comments, blanks or repeats', () => {
  assert.deepEqual(
    boundDomains('# servers\nNix.Example.com\n\nauth.example.com # sign-in\nnix.example.com\n'),
    ['localhost', 'nix.example.com', 'auth.example.com'],
  );
});

test('anything but a bare host name is refused', () => {
  for (const line of ['https://nix.example.com', 'nix.example.com:8443', 'a b', '-x.com', 'x;y'])
    assert.throws(() => boundDomains(line), /Not a host name/);
});

test('more than 10 domains, localhost included, is refused', () => {
  const nine = Array.from({ length: 9 }, (_, i) => `s${i}.example.com`).join('\n');
  assert.equal(boundDomains(nine).length, 10);
  assert.throws(() => boundDomains(`${nine}\nextra.example.com`), /10 app-bound domains/);
});
