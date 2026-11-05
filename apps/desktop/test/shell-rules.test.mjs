import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  handoffCode,
  isPrivateAddress,
  loginUrl,
  newVerifier,
  safeReturnTo,
  serverOrigin,
} from '../src/shell-rules.mjs';

test('serverOrigin accepts https and local http only, as an origin', () => {
  assert.equal(serverOrigin('nix.example.com'), 'https://nix.example.com');
  assert.equal(serverOrigin(' HTTPS://Nix.Example.com:443/a/b?c '), 'https://nix.example.com');
  assert.equal(serverOrigin('https://nix.example.com:8443'), 'https://nix.example.com:8443');
  assert.equal(serverOrigin('http://localhost:5173/'), 'http://localhost:5173');
  assert.equal(serverOrigin('http://nix.localhost'), 'http://nix.localhost');
  for (const bad of [
    '',
    '   ',
    'http://nix.example.com',
    'http://localhost.example.com',
    'http://notlocalhost',
    'https://user:pass@nix.example.com',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'ftp://nix.example.com',
    'https://',
  ])
    assert.equal(serverOrigin(bad), null, bad);
});

test('safeReturnTo keeps same-origin paths only', () => {
  assert.equal(safeReturnTo('/items/1?x=2#y'), '/items/1?x=2#y');
  for (const bad of [
    '//evil.example',
    'https://evil.example',
    '/\\evil.example',
    '/a\nb',
    'a',
    '',
    null,
    undefined,
    1,
    `/${'a'.repeat(2048)}`,
  ])
    assert.equal(safeReturnTo(bad), '/');
});

test('the verifier and challenge are the shapes the server requires', () => {
  const { verifier, challenge } = newVerifier();
  assert.match(verifier, /^[\w-]{43}$/);
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
  assert.match(challenge, /^[\w-]{43}$/);
  assert.notEqual(newVerifier().verifier, verifier);
});

test('loginUrl encodes the return path and drops an unsafe one', () => {
  assert.equal(
    loginUrl('https://a', 'c', '/x y?z=1'),
    'https://a/auth/login?native=c&returnTo=%2Fx%20y%3Fz%3D1',
  );
  assert.equal(loginUrl('https://a', 'c', '//evil'), 'https://a/auth/login?native=c&returnTo=%2F');
});

test('handoffCode takes exactly the callback shape, from the issuer the sign-in started on', () => {
  const issuer = 'https://a.example';
  const iss = encodeURIComponent(issuer);
  assert.equal(handoffCode(`app.nix.shell://auth?code=abc&iss=${iss}`, issuer), 'abc');
  assert.equal(handoffCode(`APP.NIX.SHELL://auth?iss=${iss}&code=abc`, issuer), 'abc');
  assert.equal(handoffCode(`app.nix.shell://auth?code=abc&iss=${iss}%2F`, issuer), 'abc');
  for (const bad of [
    // Another server's code: the mix-up this check exists for.
    `app.nix.shell://auth?code=abc&iss=${encodeURIComponent('https://b.example')}`,
    `app.nix.shell://auth?code=abc&iss=${encodeURIComponent('http://a.example')}`,
    'app.nix.shell://auth?code=abc',
    'app.nix.shell://auth?code=abc&iss=',
    'app.nix.shell://auth?code=abc&iss=not-a-url',
    `app.nix.shell://auth?code=&iss=${iss}`,
    `app.nix.shell://auth?iss=${iss}`,
    `app.nix.shell://other?code=abc&iss=${iss}`,
    `app.nix.shell://auth/extra?code=abc&iss=${iss}`,
    `app.nix.shell://auth?code=abc&iss=${iss}&more=1`,
    `app.nix.shell://auth?code=abc&code=def&iss=${iss}`,
    `https://auth?code=abc&iss=${iss}`,
    'not a url',
  ])
    assert.equal(handoffCode(bad, issuer), null, bad);
});

test('isPrivateAddress covers the private ranges and not the public internet', () => {
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:10.0.0.1',
    '::ffff:7f00:1',
  ])
    assert.equal(isPrivateAddress(address), true, address);
  for (const address of [
    '93.184.216.34',
    '1.1.1.1',
    '172.32.0.1',
    '2606:4700:4700::1111',
    '::ffff:1.1.1.1',
  ])
    assert.equal(isPrivateAddress(address), false, address);
});
