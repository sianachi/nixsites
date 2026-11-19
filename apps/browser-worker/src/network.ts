import { lookup } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch, type RequestInit, type Response } from 'undici';

import { BrowserFault, type SiteSession } from './contracts.ts';
import { checkEgress } from './screen.ts';

const globalIPv6 = ipaddr.IPv6.parse('2000::');
const pageLimit = 2 << 20;

export function isPublicAddress(raw: string): boolean {
  if (!ipaddr.isValid(raw)) return false;
  const ip = ipaddr.process(raw);
  return ip.range() === 'unicast' && (!(ip instanceof ipaddr.IPv6) || ip.match(globalIPv6, 3));
}

export function publicUrl(raw: string): URL {
  if (raw.length > 2048 || !URL.canParse(raw)) throw new BrowserFault('website_url_invalid');
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.port ||
    url.username ||
    url.password ||
    (isIP(host) !== 0
      ? !isPublicAddress(host)
      : !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/.test(host))
  ) {
    throw new BrowserFault('website_destination_blocked');
  }
  url.hash = '';
  return url;
}

type Resolve = typeof lookup;
export function pinnedLookup(resolve: Resolve = lookup): LookupFunction {
  return (host, options, callback) => {
    resolve(host, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, '');
        return;
      }
      const first = addresses[0];
      if (!first || addresses.some(({ address }) => !isPublicAddress(address))) {
        callback(new Error('website_destination_blocked'), '');
      } else if (options.all) {
        callback(null, addresses);
      } else {
        callback(null, first.address, first.family);
      }
    });
  };
}

const dispatcher = new Agent({ connect: { lookup: pinnedLookup() } });

export interface PageReply {
  readonly url: string;
  readonly status: number;
  readonly html: string;
  readonly contentType: string;
}

export interface PageRequest {
  readonly method: 'GET' | 'POST';
  readonly url: URL;
  readonly headers?: Record<string, string>;
  readonly body?: RequestInit['body'];
  readonly origin?: string;
  readonly session?: SiteSession;
  readonly cancellation?: AbortSignal;
}

export type FetchPage = (request: PageRequest) => Promise<PageReply>;

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body.cancel();
    throw new BrowserFault('website_response_too_large');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) throw new BrowserFault('website_response_invalid');
      size += value.byteLength;
      if (size > maxBytes) throw new BrowserFault('website_response_too_large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks, size);
}

function requestHeaders(request: PageRequest, url: URL): Record<string, string> {
  const headers = { ...request.headers, Accept: 'text/html,text/plain,application/xhtml+xml' };
  if (url.origin !== request.session?.origin) return headers;
  const header = request.session.cookies
    .filter(
      ({ path }) =>
        url.pathname === path || url.pathname.startsWith(path.endsWith('/') ? path : path + '/'),
    )
    .sort((left, right) => right.path.length - left.path.length)
    .map(({ name, value }) => name + '=' + value)
    .join('; ');
  return header ? { ...headers, Cookie: header } : headers;
}

export const fetchPublicPage: FetchPage = async (request) => {
  let url = request.url;
  const timeout = AbortSignal.timeout(10_000);
  const signal = request.cancellation ? AbortSignal.any([request.cancellation, timeout]) : timeout;
  for (let redirects = 0; redirects <= 5; redirects++) {
    url = publicUrl(url.href);
    checkEgress(url.href);
    if (request.origin && url.origin !== request.origin) {
      throw new BrowserFault('website_origin_changed');
    }
    const response = await fetch(url, {
      method: request.method,
      headers: requestHeaders(request, url),
      ...(request.body === undefined ? {} : { body: request.body }),
      dispatcher,
      redirect: 'manual',
      signal,
    });
    const location = response.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      await response.body?.cancel();
      // A submitted form may have committed before its redirect. Never replay it.
      if (request.method === 'POST') {
        return { url: url.href, status: response.status, html: '', contentType: 'text/plain' };
      }
      if (location.length > 2048) throw new BrowserFault('website_url_invalid');
      url = new URL(location, url);
      continue;
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!/^(text\/html|text\/plain|application\/xhtml\+xml)(?:;|$)/i.test(contentType)) {
      await response.body?.cancel();
      if (request.method === 'POST') {
        return { url: url.href, status: response.status, html: '', contentType: 'text/plain' };
      }
      throw new BrowserFault('website_content_unsupported');
    }
    const bytes = await readLimited(response, pageLimit);
    return {
      url: url.href,
      status: response.status,
      html: new TextDecoder().decode(bytes),
      contentType,
    };
  }
  throw new BrowserFault('website_too_many_redirects');
};

export async function readAttachment(
  source: string,
  trustedOrigin: string,
  size: number,
  cancellation: AbortSignal,
): Promise<Uint8Array> {
  const url = new URL(source);
  if (
    url.origin !== trustedOrigin ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    !url.search
  ) {
    throw new BrowserFault('attachment_grant_invalid');
  }
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.any([cancellation, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new BrowserFault('attachment_unavailable');
  }
  const bytes = await readLimited(response, size);
  if (bytes.byteLength !== size) throw new BrowserFault('attachment_changed');
  return bytes;
}
