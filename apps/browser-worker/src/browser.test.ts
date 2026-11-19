import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBrowserService, type BrowserService } from './browser.ts';
import type { FormProposal } from './contracts.ts';
import { pinnedLookup, publicUrl, type PageRequest } from './network.ts';
import { createBrowserServer } from './server.ts';

const pageUrl = 'https://forms.example.test/request';
const field = { name: 'message', value: 'Reviewed request' };
const actionId = '47b61b68-bb2f-406e-afbb-d9440d0d848d';
const title = '<title>A request form</title>';
const html =
  title +
  '<script>document.title = "Injected"; fetch("http://127.0.0.1/private");</script>' +
  '<img src="http://169.254.169.254/metadata">' +
  '<form method="post" action="/requests">' +
  '<label>Request<input name="message" required></label>' +
  '<button>Send request</button></form>';

let browser: BrowserService | undefined;
afterEach(async () => {
  await browser?.close();
  browser = undefined;
}, 35_000);

function testBrowser(options?: { attachmentOrigin: string }) {
  let document = html;
  const requests: PageRequest[] = [];
  const service = createBrowserService({
    ...options,
    fetchPage: (request) => {
      requests.push(request);
      return Promise.resolve({
        html: document,
        contentType: 'text/html',
        url: request.url.href,
        status: 200,
      });
    },
  });
  browser = service;
  return {
    service,
    requests,
    setDocument: (value: string) => {
      document = value;
    },
  };
}

function reviewForm(
  page: Awaited<ReturnType<BrowserService['run']>>,
  fields: FormProposal['fields'],
  attachments: FormProposal['attachments'] = [],
): FormProposal {
  if (!('forms' in page)) throw new Error('Expected a browsed page.');
  const form = page.forms[0];
  if (!form?.supported) throw new Error('Expected a supported form.');
  return {
    pageUrl: page.citation,
    target: form.target,
    method: form.method,
    formIndex: form.index,
    revision: form.revision,
    fields,
    attachments,
  };
}

describe('browser page and form work', () => {
  it('inspects native forms with no subresource egress and sends only the reviewed form', async () => {
    const { service, requests } = testBrowser();
    await expect(service.ready()).resolves.toBe(true);
    const page = await service.run({ operation: 'browse', url: pageUrl });

    expect(page).toMatchObject({
      title: 'A request form',
      citation: pageUrl,
      forms: [
        {
          index: 0,
          supported: true,
          target: 'https://forms.example.test/requests',
          fields: [{ name: 'message', kind: 'text', required: true }],
        },
      ],
    });
    expect(JSON.stringify(page)).not.toContain('secret-nonce');
    expect(requests.map(({ method, url }) => [method, url.href])).toEqual([['GET', pageUrl]]);

    const preview = reviewForm(page, [field]);
    expect(JSON.stringify(preview)).not.toContain('secret-nonce');
    expect(requests.every(({ method }) => method === 'GET')).toBe(true);

    const result = await service.run({
      operation: 'submit',
      actionId,
      proposal: preview,
      attachments: [],
    });

    expect(result).toEqual({ actionId, dispatched: true, status: 200 });
    const submissions = requests.filter(({ method }) => method === 'POST');
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.url.href).toBe('https://forms.example.test/requests');
    const body = submissions[0]?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect(body instanceof URLSearchParams ? body.toString() : null).toBe(
      'message=Reviewed+request',
    );
  }, 20_000);

  it('requires a fresh review after the form changes and on unsupported forms', async () => {
    const { service, requests, setDocument } = testBrowser();
    const proposal = reviewForm(await service.run({ operation: 'browse', url: pageUrl }), [field]);

    setDocument(html.replace('A request form', 'The page changed before review'));
    await expect(
      service.run({ operation: 'submit', actionId, proposal, attachments: [] }),
    ).rejects.toMatchObject({ code: 'website_form_changed' });

    setDocument(html.replace('action="/requests"', 'action="https://unrelated.test/requests"'));
    await expect(
      service.run({ operation: 'submit', actionId, proposal, attachments: [] }),
    ).rejects.toMatchObject({ code: 'website_form_needs_takeover' });

    setDocument(
      html.replace('<button>', '<input type="hidden" name="operation" value="change"><button>'),
    );
    await expect(
      service.run({ operation: 'submit', actionId, proposal, attachments: [] }),
    ).rejects.toMatchObject({ code: 'website_form_needs_takeover' });
    expect(requests.every(({ method }) => method === 'GET')).toBe(true);
  }, 20_000);

  it('keeps a connected session on its origin and refuses to expose reflected cookie values', async () => {
    const { service, requests, setDocument } = testBrowser();
    const cookie = { name: 'session', value: 'connected-cookie', path: '/' };
    const session = { origin: 'https://forms.example.test', cookies: [cookie] };
    setDocument(html + '<p>' + cookie.value + '</p>');

    await expect(service.run({ operation: 'browse', url: pageUrl, session })).rejects.toMatchObject(
      {
        code: 'website_response_contains_secret',
      },
    );
    await expect(
      service.run({ operation: 'browse', url: 'https://other.example.test/', session }),
    ).rejects.toMatchObject({ code: 'website_origin_changed' });
    expect(requests.map(({ url }) => url.href)).toEqual([pageUrl]);
  }, 20_000);

  it('blocks recognized credentials from public query strings and approved form fields', async () => {
    const { service, requests } = testBrowser();
    const fakeCredential = 'ghp_' + 'sample'.repeat(6);
    const errors = { code: 'website_egress_blocked', dispatched: false };

    await expect(service.run({ operation: 'search', query: fakeCredential })).rejects.toMatchObject(
      errors,
    );
    await expect(
      service.run({ operation: 'browse', url: pageUrl + '?token=' + fakeCredential }),
    ).rejects.toMatchObject(errors);
    expect(requests).toEqual([]);

    const proposal = reviewForm(await service.run({ operation: 'browse', url: pageUrl }), [
      { name: 'message', value: 'Use ' + fakeCredential },
    ]);
    await expect(
      service.run({ operation: 'submit', actionId, proposal, attachments: [] }),
    ).rejects.toMatchObject(errors);
    expect(requests.map(({ method }) => method)).toEqual(['GET']);
  }, 20_000);

  it('checks attachment contents against their reviewed digest before sending', async () => {
    const file = 'reviewed bytes';
    let current: string | Buffer = file;
    const storage = createServer((_, res) => res.end(current));
    storage.listen(0, '127.0.0.1');
    await once(storage, 'listening');
    const address = storage.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture storage.');
    const origin = 'http://127.0.0.1:' + String(address.port);
    try {
      const { service, requests, setDocument } = testBrowser({ attachmentOrigin: origin });
      setDocument(
        '<form method="post" enctype="multipart/form-data" action="/upload">' +
          '<input type="file" name="report" required><button>Upload report</button></form>',
      );
      const attachment = {
        field: 'report',
        filename: 'result.txt',
        contentType: 'text/plain',
        size: Buffer.byteLength(file),
        sha256: createHash('sha256').update(file).digest('hex'),
      };
      const preview = reviewForm(
        await service.run({ operation: 'browse', url: pageUrl }),
        [],
        [attachment],
      );
      const grant = { ...attachment, source: origin + '/file?signed=fixture-secret' };
      expect(JSON.stringify(preview)).not.toContain('fixture-secret');

      await expect(
        service.run({
          operation: 'submit',
          actionId,
          proposal: preview,
          attachments: [grant],
        }),
      ).resolves.toMatchObject({ dispatched: true });
      const post = requests.find(({ method }) => method === 'POST');
      expect(post?.body).toBeDefined();

      current = Buffer.from([0xc0, 0xaf]);
      const unreadable = {
        ...attachment,
        size: current.byteLength,
        sha256: createHash('sha256').update(current).digest('hex'),
      };
      await expect(
        service.run({
          operation: 'submit',
          actionId,
          proposal: { ...preview, attachments: [unreadable] },
          attachments: [{ ...grant, ...unreadable }],
        }),
      ).rejects.toMatchObject({ code: 'attachment_egress_blocked', dispatched: false });
      expect(requests.filter(({ method }) => method === 'POST')).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => {
        storage.close(() => {
          resolve();
        });
      });
    }
  }, 20_000);

  it('serves only secret-authenticated commands through the worker', async () => {
    const run = vi.fn().mockResolvedValue({ citation: pageUrl, links: [] });
    const ready = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const server = createBrowserServer({
      secret: 'fixture-worker-secret',
      browser: {
        run,
        ready,
        close: () => Promise.resolve(),
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture worker.');
    const origin = 'http://127.0.0.1:' + String(address.port);
    const target = origin + '/v1/browser';
    try {
      expect((await fetch(origin + '/healthz')).status).toBe(200);
      expect((await fetch(origin + '/readyz')).status).toBe(503);
      expect((await fetch(origin + '/readyz')).status).toBe(200);
      const body = JSON.stringify({ operation: 'browse', url: pageUrl });
      expect((await fetch(target, { method: 'POST', body })).status).toBe(401);
      expect(run).not.toHaveBeenCalled();
      const response = await fetch(target, {
        method: 'POST',
        body,
        headers: { 'X-Nix-Internal-Secret': 'fixture-worker-secret' },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(run).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });
});

describe('public network boundary', () => {
  it.each([
    'http://127.0.0.1/',
    'http://2130706433/',
    'https://[::ffff:127.0.0.1]/',
    'https://[fe80::1]/',
    'http://169.254.169.254/',
    'http://100.64.0.1/',
    'https://metadata.google.internal/',
    'https://foo.localhost/',
    'https://user:password@public.example.test/',
    'https://public.example.test:8443/',
    'file:///local',
  ])('rejects %s', (url) => {
    expect(() => publicUrl(url)).toThrow();
  });

  it('blocks a private resolved address at connection time', async () => {
    const blocked = await new Promise<string | undefined>((resolve) => {
      pinnedLookup()('localhost', { family: 4 }, (error) => {
        resolve(error?.message);
      });
    });
    expect(blocked).toBe('website_destination_blocked');
  });
});
