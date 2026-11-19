import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { chromium, type Browser, type Page } from 'playwright';
import { FormData } from 'undici';

import {
  BrowserFault,
  type Attachment,
  type BrowserCommand,
  type SiteSession,
} from './contracts.ts';
import { describeForms, prepareForm, readForms, sameProposal, type FormSummary } from './forms.ts';
import {
  fetchPublicPage,
  publicUrl,
  readAttachment,
  type FetchPage,
  type PageReply,
} from './network.ts';
import { checkAttachment, checkEgress } from './screen.ts';

const searchSite = 'https://html.duckduckgo.com/html/';
const csp = "default-src 'none'; form-action 'none'; base-uri 'self'; sandbox";

interface PageLink {
  readonly url: string;
  readonly title: string;
}

type BrowserReply =
  | { citation: string; links: PageLink[] }
  | { citation: string; text: string; title: string; links: PageLink[]; forms: FormSummary[] }
  | { actionId: string; dispatched: true; status: number };

export interface BrowserService {
  close(): Promise<void>;
  ready(): Promise<boolean>;
  run(command: BrowserCommand, cancellation?: AbortSignal): Promise<BrowserReply>;
}

export interface BrowserOptions {
  readonly fetchPage?: FetchPage;
  readonly attachmentOrigin?: string;
}

async function launchBrowser(): Promise<{ browser: Browser; close: () => Promise<void> }> {
  // Interception is an optimization. Chromium has no usable egress path if a request escapes it.
  const proxy = createServer((_, res) => res.writeHead(403).end());
  proxy.on('connect', (_, socket) => socket.destroy());
  proxy.on('upgrade', (_, socket) => socket.destroy());
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const address = proxy.address();
  if (!address || typeof address === 'string') {
    proxy.close();
    throw new BrowserFault('browser_unavailable');
  }
  try {
    const browser = await chromium.launch({
      channel: 'chromium',
      chromiumSandbox: true,
      proxy: { server: 'http://127.0.0.1:' + String(address.port), bypass: '<-loopback>' },
      args: [
        '--disable-background-networking',
        '--disable-quic',
        '--host-resolver-rules=MAP * ~NOTFOUND',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      ],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmpdir(), TMPDIR: tmpdir() },
      timeout: 10_000,
    });
    return {
      browser,
      async close() {
        proxy.close();
        proxy.closeAllConnections();
        await browser.close();
      },
    };
  } catch (error) {
    proxy.close();
    throw error;
  }
}

function inOrigin(url: URL, session?: SiteSession): void {
  if (!session) return;
  const origin = publicUrl(session.origin);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== session.origin ||
    url.origin !== origin.origin
  ) {
    throw new BrowserFault('website_origin_changed');
  }
}

function screen(result: unknown, session?: SiteSession): void {
  if (!session) return;
  const text = JSON.stringify(result);
  for (const { value } of session.cookies) {
    if (
      [value, encodeURIComponent(value), Buffer.from(value).toString('base64')].some((secret) =>
        text.includes(secret),
      )
    ) {
      throw new BrowserFault('website_response_contains_secret');
    }
  }
}

async function withDocument<T>(
  browser: Browser,
  response: PageReply,
  cancellation: AbortSignal,
  inspect: (page: Page, url: URL) => Promise<T>,
): Promise<T> {
  cancellation.throwIfAborted();
  const url = publicUrl(response.url);
  const context = await browser.newContext({
    acceptDownloads: false,
    javaScriptEnabled: false,
    serviceWorkers: 'block',
  });
  const closePage = (): void => {
    void context.close().catch(() => undefined);
  };
  cancellation.addEventListener('abort', closePage, { once: true });
  try {
    cancellation.throwIfAborted();
    let served = false;
    await context.route('**/*', async (route) => {
      const request = route.request();
      if (
        served ||
        !request.isNavigationRequest() ||
        request.method() !== 'GET' ||
        request.url() !== url.href
      ) {
        await route.abort('blockedbyclient');
        return;
      }
      served = true;
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': response.contentType.replace(/;.*/, '') + '; charset=utf-8',
          'Content-Security-Policy': csp,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        },
        body: response.html,
      });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 8_000 });
    return await inspect(page, url);
  } finally {
    cancellation.removeEventListener('abort', closePage);
    await context.close();
  }
}

function collectPage(page: Page, search = false) {
  return page.evaluate((isSearch) => {
    const anchors = isSearch
      ? document.querySelectorAll<HTMLAnchorElement>('.result__a')
      : document.querySelectorAll<HTMLAnchorElement>('a[href]');
    return {
      title: document.title.slice(0, 300),
      text: (document.querySelector('body')?.innerText ?? '').trim().slice(0, 16_000),
      links: [...anchors].slice(0, 40).map((link) => ({
        url: link.href.slice(0, 2049),
        title: link.innerText.trim().slice(0, 300),
      })),
    };
  }, search);
}

function resultLinks(links: Awaited<ReturnType<typeof collectPage>>['links'], search: boolean) {
  return links.flatMap(({ url: raw, title }) => {
    try {
      const url = publicUrl(raw);
      const direct =
        search &&
        ['duckduckgo.com', 'html.duckduckgo.com'].includes(url.hostname) &&
        url.pathname === '/l/'
          ? url.searchParams.get('uddg')
          : null;
      return [{ url: publicUrl(direct ?? url.href).href, title }];
    } catch {
      return [];
    }
  });
}

function boundedList<T>(items: T[], budget: number): T[] {
  return items.filter((item) => {
    const bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes > budget) return false;
    budget -= bytes;
    return true;
  });
}

async function submissionBody(
  command: Extract<BrowserCommand, { operation: 'submit' }>,
  enctype: string,
  cancellation: AbortSignal,
  attachmentOrigin?: string,
) {
  const {
    proposal: { fields, attachments },
  } = command;
  const { attachments: grants } = command;
  if (grants.length !== attachments.length) throw new BrowserFault('attachment_grant_invalid');
  const values: [string, string][] = fields.map(({ name, value }) => [name, value]);
  if (enctype === 'application/x-www-form-urlencoded') return new URLSearchParams(values);
  const data = new FormData();
  for (const [name, value] of values) data.append(name, value);
  for (const attachment of attachments) {
    const grant = grants.find(({ field }) => field === attachment.field);
    if (!attachmentOrigin || !grant || !sameAttachment(attachment, grant)) {
      throw new BrowserFault('attachment_grant_invalid');
    }
    const bytes = await readAttachment(
      grant.source,
      attachmentOrigin,
      attachment.size,
      cancellation,
    );
    if (createHash('sha256').update(bytes).digest('hex') !== attachment.sha256) {
      throw new BrowserFault('attachment_changed');
    }
    checkAttachment(bytes);
    checkEgress(attachment.filename);
    data.append(
      attachment.field,
      new File([new Uint8Array(bytes)], attachment.filename, { type: attachment.contentType }),
    );
  }
  return data;
}

function sameAttachment(approved: Attachment, actual: Attachment): boolean {
  return (
    approved.field === actual.field &&
    approved.filename === actual.filename &&
    approved.size === actual.size &&
    approved.sha256 === actual.sha256 &&
    approved.contentType === actual.contentType
  );
}

export function createBrowserService(options: BrowserOptions = {}): BrowserService {
  const fetchPage = options.fetchPage ?? fetchPublicPage;
  let launched: ReturnType<typeof launchBrowser> | undefined;
  let active = 0;

  async function useBrowser(): Promise<Browser> {
    launched ??= launchBrowser()
      .then((connection) => {
        connection.browser.once('disconnected', () => {
          launched = undefined;
          void connection.close().catch(() => undefined);
        });
        return connection;
      })
      .catch((error: unknown) => {
        launched = undefined;
        throw error;
      });
    return (await launched).browser;
  }

  async function read(url: URL, cancellation: AbortSignal, session?: SiteSession) {
    cancellation.throwIfAborted();
    inOrigin(url, session);
    const result = await fetchPage(
      session
        ? { method: 'GET', url, origin: session.origin, session, cancellation }
        : { method: 'GET', url, cancellation },
    );
    inOrigin(publicUrl(result.url), session);
    if (result.status >= 400) throw new BrowserFault('website_read_failed');
    return result;
  }

  return {
    async close(): Promise<void> {
      if (launched) await (await launched).close();
    },

    async ready(): Promise<boolean> {
      try {
        return (await useBrowser()).isConnected();
      } catch {
        return false;
      }
    },

    async run(command: BrowserCommand, disconnected?: AbortSignal): Promise<BrowserReply> {
      const timeout = AbortSignal.timeout(30_000);
      const cancellation = disconnected ? AbortSignal.any([disconnected, timeout]) : timeout;
      if (active >= 4) throw new BrowserFault('browser_busy');
      active++;
      try {
        if (command.operation === 'search') {
          checkEgress(command.query);
          const url = new URL(searchSite);
          url.searchParams.set('q', command.query);
          const response = await read(url, cancellation);
          return await withDocument(
            await useBrowser(),
            response,
            cancellation,
            async (page, citation) => {
              const result = await collectPage(page, true);
              return {
                citation: citation.href,
                links: boundedList(resultLinks(result.links, true), 6000),
              };
            },
          );
        }

        const url = publicUrl(
          command.operation === 'submit' ? command.proposal.pageUrl : command.url,
        );
        checkEgress(url.href);
        screen(url.href, command.session);
        if (command.operation === 'submit') {
          checkEgress(command.proposal.target);
          for (const { name, value } of command.proposal.fields) checkEgress(value, name);
          screen(command.proposal, command.session);
        }
        const response = await read(url, cancellation, command.session);
        const browser = await useBrowser();
        if (command.operation === 'browse') {
          return await withDocument(browser, response, cancellation, async (page, citation) => {
            const result = await collectPage(page);
            const forms = describeForms(
              (await readForms(page)).slice(0, 4),
              citation,
              response.html,
            );
            const detail = {
              ...result,
              citation: citation.href,
              links: resultLinks(result.links, false),
              forms,
            };
            screen(detail, command.session);
            // Leave room for the receipt wrapper and Core's JSON escaping when it persists this page.
            return {
              ...detail,
              text: detail.text.slice(0, 4000),
              links: boundedList(detail.links, 3500),
              forms: boundedList(detail.forms, 6500),
            };
          });
        }
        const request = command.proposal;
        const prepared = await withDocument(
          browser,
          response,
          cancellation,
          async (page, citation) => {
            const forms = await readForms(page);
            return prepareForm(
              forms[request.formIndex],
              citation,
              response.html,
              request.formIndex,
              request.fields,
              request.attachments,
            );
          },
        );
        screen(prepared.proposal, command.session);
        if (!sameProposal(prepared.proposal, command.proposal)) {
          throw new BrowserFault('website_form_changed');
        }
        const body = await submissionBody(
          command,
          prepared.enctype,
          cancellation,
          options.attachmentOrigin,
        );
        const target = publicUrl(prepared.proposal.target);
        inOrigin(target, command.session);
        cancellation.throwIfAborted();
        try {
          const receipt = await fetchPage({
            method: 'POST',
            url: target,
            origin: target.origin,
            ...(command.session ? { session: command.session } : {}),
            headers: { Origin: target.origin },
            body,
            cancellation,
          });
          return { actionId: command.actionId, dispatched: true, status: receipt.status };
        } catch {
          throw new BrowserFault('website_outcome_unknown', true);
        }
      } finally {
        active--;
      }
    },
  };
}
