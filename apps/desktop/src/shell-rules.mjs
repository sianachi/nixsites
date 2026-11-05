import { createHash, randomBytes } from 'node:crypto';
import { BlockList, isIP } from 'node:net';

export const CALLBACK_SCHEME = 'app.nix.shell';

export const isLocalHost = (hostname) =>
  hostname === 'localhost' || hostname.endsWith('.localhost');

/**
 * The origin a typed server address names, or null when the shell must not open it. Plain http only
 * for a stack on this machine: Chromium resolves `*.localhost` to loopback by itself and treats it
 * as a secure context, so a local install works offline too.
 */
export function serverOrigin(input) {
  const text = String(input).trim();
  if (text === '') return null;
  let url;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return null;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname)))
    return null;
  return url.origin;
}

const PRIVATE_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4],
])
  PRIVATE_ADDRESSES.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
])
  PRIVATE_ADDRESSES.addSubnet(network, prefix, 'ipv6');

/** Loopback, private, link-local and the like; an IPv4-mapped IPv6 address counts as its IPv4 one. */
export const isPrivateAddress = (address) =>
  PRIVATE_ADDRESSES.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');

/** A same-origin path; anything else (absolute, protocol-relative, backslashes, control characters) becomes "/". */
export function safeReturnTo(path) {
  return typeof path === 'string' &&
    path.startsWith('/') &&
    !path.startsWith('//') &&
    path.length <= 2048 &&
    !path.includes('\\') &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(path)
    ? path
    : '/';
}

/** 32 random bytes as 43 base64url characters, and the SHA-256 challenge sent in its place. */
export function newVerifier() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export const loginUrl = (origin, challenge, returnTo) =>
  `${origin}/auth/login?native=${challenge}&returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;

/**
 * The code from `app.nix.shell://auth?code=...&iss=...`, only for exactly that shape and only from
 * the server the sign-in started on (RFC 9207). Without this a malicious saved server could redirect
 * the browser to another server's login and be handed the code and the verifier for it.
 */
export function handoffCode(input, issuer) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const params = Object.fromEntries(url.searchParams);
  if (
    url.protocol !== `${CALLBACK_SCHEME}:` ||
    url.hostname !== 'auth' ||
    (url.pathname !== '' && url.pathname !== '/') ||
    [...url.searchParams].length !== 2 ||
    !params.code ||
    !params.iss
  )
    return null;
  try {
    return new URL(params.iss).origin === issuer ? params.code : null;
  } catch {
    return null;
  }
}
