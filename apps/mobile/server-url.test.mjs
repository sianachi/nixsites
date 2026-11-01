import assert from 'node:assert/strict';
import { test } from 'node:test';

import { serverOrigin } from './www/server-url.mjs';

test('a bare host or full URL becomes its https origin', () => {
  assert.equal(serverOrigin(' nix.example.com '), 'https://nix.example.com');
  assert.equal(
    serverOrigin('https://Nix.Example.com:8443/w/1?x=1'),
    'https://nix.example.com:8443',
  );
});

test('plain http is refused except for localhost', () => {
  assert.equal(serverOrigin('http://nix.example.com'), null);
  assert.equal(serverOrigin('http://localhost:5173'), 'http://localhost:5173');
  assert.equal(serverOrigin('http://app.localhost'), null);
});

test('credentials, other schemes and junk are refused', () => {
  assert.equal(serverOrigin('https://me:pw@nix.example.com'), null);
  assert.equal(serverOrigin('javascript:alert(1)'), null);
  assert.equal(serverOrigin('ftp://nix.example.com'), null);
  assert.equal(serverOrigin(''), null);
  assert.equal(serverOrigin('https://'), null);
});
