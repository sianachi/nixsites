import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import {
  FILE_URL_PREFIX,
  createPublicLinkCore,
  registerPublicLinkRoutes,
  renderPublicNote,
  type FileVerdict,
  type PublicLinkCore,
} from './public-links.ts';

const ids = {
  linkId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  principalId: '33333333-3333-4333-8333-333333333333',
  workspaceId: '44444444-4444-4444-8444-444444444444',
  itemId: '55555555-5555-4555-8555-555555555555',
};
const scope = {
  tenantId: ids.tenantId,
  principalId: ids.principalId,
  workspaceId: ids.workspaceId,
  itemId: ids.itemId,
};
const f = (n: number) => `66666666-6666-4666-8666-66666666666${String(n)}`;
const [APPROVED, DRAFT, PNG, SVG, HIDDEN, PAGE] = [f(1), f(2), f(3), f(4), f(5), f(6)];

const verdict = (
  id: string,
  disposition: FileVerdict['disposition'],
  name: string | null = null,
  mediaType: string | null = null,
): FileVerdict => ({ id, disposition, name, mediaType });

const BLOCKS = [
  verdict(APPROVED, 'servable', 'plan.pdf', 'application/pdf'),
  verdict(DRAFT, 'withheld', 'draft.docx'),
  verdict(HIDDEN, 'hidden'),
  verdict(PAGE, 'hidden'),
];
const IMAGES = [verdict(PNG, 'servable', 'a.png', 'image/png'), verdict(SVG, 'withheld', 'b.svg')];

const asMaps = (blocks = BLOCKS, images = IMAGES) =>
  Promise.resolve({
    blocks: new Map(blocks.map((entry) => [entry.id, entry])),
    images: new Map(images.map((entry) => [entry.id, entry])),
  });

const text = (value: string, marks: unknown[] = []) => ({ type: 'text', text: value, marks });
const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const doc = (...content: unknown[]) => ({ type: 'doc', content });
const block = (targetId: string, presentation = 'attachment') => ({
  type: 'itemBlock',
  attrs: { targetId, presentation, view: null },
});
const render = (body: unknown) => renderPublicNote(body, ids.itemId, () => asMaps());

describe('renderPublicNote', () => {
  it('escapes markup in text, attributes and link addresses', async () => {
    const note = await render(
      doc(
        para(text('<script>alert(1)</script>')),
        para(text('x', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }])),
        para(text('y', [{ type: 'link', attrs: { href: 'https://a.test/?q="><b>' } }])),
        { type: 'image', attrs: { fileItemId: PNG, alt: '" onerror="x' } },
      ),
    );
    expect(note?.html).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>\n' +
        '<p>x</p>\n' +
        '<p><a href="https://a.test/?q=&quot;&gt;&lt;b&gt;" rel="noopener noreferrer">y</a></p>\n' +
        `<figure class="nix-figure"><img src="${FILE_URL_PREFIX}${PNG}" alt="&quot; onerror=&quot;x" loading="lazy" decoding="async"></figure>`,
    );
  });

  it('serves an approved attachment, names an unapproved one, and hides the rest', async () => {
    const note = await render(doc(block(APPROVED), block(DRAFT), block(HIDDEN), para(text('end'))));
    expect(note?.html).toContain(`href="${FILE_URL_PREFIX}${APPROVED}"`);
    expect(note?.html).toContain('plan.pdf');
    expect(note?.html).toContain('draft.docx (not available)');
    expect(note?.html).not.toContain(DRAFT);
    expect(note?.html).not.toContain(HIDDEN);
    expect(note?.html).toContain('An attachment is not available.');
    expect(note?.servableFileIds).toEqual([APPROVED]);
    expect(note?.withheldFiles).toEqual([{ fileItemId: DRAFT, name: 'draft.docx' }]);
  });

  it('applies the image rule: servable image kept, anything else withheld by name', async () => {
    const note = await render(
      doc(
        { type: 'image', attrs: { fileItemId: PNG } },
        { type: 'image', attrs: { fileItemId: SVG } },
      ),
    );
    expect(note?.html).toContain(`src="${FILE_URL_PREFIX}${PNG}"`);
    expect(note?.html).not.toContain(SVG);
    expect(note?.html).toContain('b.svg (not available)');
  });

  it('removes embedded items and never prints their title or a "Linked item" stand-in', async () => {
    const note = await render(
      doc(para(text('before')), block(PAGE, 'embed'), block(PAGE, 'card'), para(text('after'))),
    );
    expect(note?.html).toBe('<p>before</p>\n<p>after</p>');
  });

  it('flattens item links and mentions to their label with no link and no file URL', async () => {
    const note = await render(
      doc(
        para(
          { type: 'reference', attrs: { kind: 'item', targetId: PAGE, label: 'Roadmap' } },
          text(' '),
          { type: 'reference', attrs: { kind: 'principal', targetId: HIDDEN, label: 'Sam' } },
          text(' '),
          { type: 'reference', attrs: { kind: 'item', targetId: APPROVED, label: 'plan' } },
        ),
      ),
    );
    expect(note?.html).toContain('<span class="nix-ref-text">Roadmap</span>');
    expect(note?.html).toContain('<span class="nix-ref-text">Sam</span>');
    expect(note?.html).not.toContain(PAGE);
    expect(note?.html).not.toContain(HIDDEN);
    expect(note?.html).toContain(`href="${FILE_URL_PREFIX}${APPROVED}"`);
  });

  it('omits comments and drops unknown nodes', async () => {
    const note = await render(
      doc(para(text('seen', [{ type: 'comment', attrs: { threadId: 'secret thread' } }])), {
        type: 'mysteryEmbed',
        attrs: { body: 'hidden body' },
        content: [para(text('inner'))],
      }),
    );
    expect(note?.html).toBe('<p>seen</p>');
  });

  it('shows only accepted content: proposals vanish and proposed deletions stay', async () => {
    const mark = (type: string) => [{ type, attrs: { id: 's1' } }];
    const note = await render(
      doc(
        para(
          text('kept '),
          text('proposed ', mark('suggestionInsert')),
          text('struck', mark('suggestionDelete')),
        ),
        block(HIDDEN),
        {
          ...block(DRAFT),
          attrs: {
            targetId: DRAFT,
            presentation: 'attachment',
            suggestion: { op: 'insert', id: 's2' },
          },
        },
      ),
    );
    expect(note?.html).toContain('<p>kept struck</p>');
    expect(note?.html).not.toContain('proposed');
    // The proposed attachment is neither shown nor reported.
    expect(note?.withheldFiles.map((file) => file.fileItemId)).not.toContain(DRAFT);
  });

  it('asks Core only about files the accepted body names', async () => {
    const asked: { blocks: string[]; images: string[] }[] = [];
    await renderPublicNote(doc(para(text('plain'))), ids.itemId, (request) => {
      asked.push(request);
      return asMaps();
    });
    expect(asked).toEqual([]);
  });

  it('refuses when Core cannot answer for the files', async () => {
    expect(
      await renderPublicNote(doc(block(APPROVED)), ids.itemId, () => Promise.resolve(null)),
    ).toBe(null);
  });
});

describe('the internal route', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  const url = `/internal/public-links/${ids.linkId}/render`;
  const headers = { 'x-nix-internal-secret': 'secret' };
  const grant = { title: 'Plan', bodyKind: 'note' };
  const files = { blocks: BLOCKS, images: IMAGES };

  function server(
    core: Partial<PublicLinkCore>,
    readNote = () => Promise.resolve(doc(para(text('hi')))),
  ) {
    const app = Fastify();
    registerPublicLinkRoutes(app, {
      internalSecret: 'secret',
      pool: new Proxy({} as Pool, {
        get() {
          throw new Error('Unauthorized database access');
        },
      }),
      publicLinkCore: {
        authorize: () => Promise.resolve(grant),
        files: () => Promise.resolve(files),
        ...core,
      },
      readNote,
    });
    apps.push(app);
    return app;
  }

  it('refuses without the service secret and never calls Core or the database', async () => {
    const response = await server({
      authorize() {
        throw new Error('must not authorize');
      },
    }).inject({ method: 'POST', url, payload: scope });
    expect(response.statusCode).toBe(404);
  });

  it('never reads a body when Core does not authorize the link', async () => {
    for (const [answer, status] of [
      [null, 404],
      ['unavailable', 503],
      [{ title: 'x', bodyKind: 'canvas' }, 404],
    ] as const) {
      const response = await server({ authorize: () => Promise.resolve(answer) }, () => {
        throw new Error('must not read');
      }).inject({ method: 'POST', url, payload: scope, headers });
      expect(response.statusCode).toBe(status);
    }
  });

  it('has no authorizer wired at all: refuses rather than reading', async () => {
    const app = Fastify();
    registerPublicLinkRoutes(app, {
      internalSecret: 'secret',
      pool: {} as Pool,
      readNote: () => {
        throw new Error('must not read');
      },
    });
    apps.push(app);
    const response = await app.inject({ method: 'POST', url, payload: scope, headers });
    expect(response.statusCode).toBe(503);
  });

  it('rejects a malformed scope', async () => {
    const response = await server({}).inject({
      method: 'POST',
      url,
      payload: { ...scope, itemId: 'nope' },
      headers,
    });
    expect(response.statusCode).toBe(400);
  });

  it('answers with the title and html, uncached', async () => {
    const response = await server({}).inject({ method: 'POST', url, payload: scope, headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      title: 'Plan',
      html: '<p>hi</p>',
      servableFileIds: [],
      withheldFiles: [],
    });
  });

  it('answers 503 when Core is unavailable for the file check', async () => {
    const response = await server({ files: () => Promise.resolve('unavailable') }, () =>
      Promise.resolve(doc(block(APPROVED))),
    ).inject({ method: 'POST', url, payload: scope, headers });
    expect(response.statusCode).toBe(503);
  });
});

const urlOf = (value: Parameters<typeof fetch>[0]) =>
  typeof value === 'string' ? value : value instanceof URL ? value.href : value.url;
const bodyOf = (init: RequestInit | undefined) => (typeof init?.body === 'string' ? init.body : '');

describe('the Core client', () => {
  it('sends the secret and the exact link scope, and rejects an answer for another item', async () => {
    const sent: { url: string; body: unknown }[] = [];
    const core = createPublicLinkCore({
      coreBaseUrl: 'http://core',
      internalSecret: 'secret',
      fetch: (url, init) => {
        sent.push({ url: urlOf(url), body: JSON.parse(bodyOf(init)) });
        return Promise.resolve(
          Response.json({
            permission: 'read',
            itemId: ids.itemId,
            workspaceId: ids.workspaceId,
            title: 'T',
            bodyKind: 'note',
          }),
        );
      },
    });
    expect(await core.authorize({ ...scope, linkId: ids.linkId })).toEqual({
      title: 'T',
      bodyKind: 'note',
    });
    expect(sent[0]?.url).toBe(`http://core/internal/public-links/${ids.linkId}/authorize`);
    expect(sent[0]?.body).toEqual(scope);

    const other = createPublicLinkCore({
      coreBaseUrl: 'http://core',
      internalSecret: 'secret',
      fetch: () =>
        Promise.resolve(
          Response.json({
            permission: 'read',
            itemId: f(9),
            workspaceId: ids.workspaceId,
            title: 'T',
            bodyKind: 'note',
          }),
        ),
    });
    expect(await other.authorize({ ...scope, linkId: ids.linkId })).toBeNull();
  });

  it('treats a write permission or a server error as no grant', async () => {
    const make = (response: () => Response) =>
      createPublicLinkCore({
        coreBaseUrl: 'http://core',
        internalSecret: 'secret',
        fetch: () => Promise.resolve(response()),
      });
    const body = { itemId: ids.itemId, workspaceId: ids.workspaceId, title: 'T', bodyKind: 'note' };
    expect(
      await make(() => Response.json({ ...body, permission: 'write' })).authorize({
        ...scope,
        linkId: ids.linkId,
      }),
    ).toBeNull();
    expect(
      await make(() => new Response('', { status: 500 })).authorize({
        ...scope,
        linkId: ids.linkId,
      }),
    ).toBe('unavailable');
  });
});
