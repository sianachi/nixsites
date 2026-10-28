import { describe, expect, it } from 'vitest';

import { renderSite } from './render.js';
import { buildSearchIndex, tokenize, type SearchIndex } from './search.js';
import { aSite, fileText } from './site.test-helper.js';

describe('the search index', () => {
  it('holds exactly the rendered pages', () => {
    const site = aSite();
    const rendered = renderSite(site);
    const index = JSON.parse(fileText(rendered.files, '_nix/search.json')) as SearchIndex;
    expect(index.docs.map((doc) => doc.p).sort()).toEqual(
      site.pages.map((page) => page.path).sort(),
    );
    expect(index.terms.zebra).toEqual([index.docs.findIndex((doc) => doc.p === '/posts/first/')]);
  });

  it('never indexes a body whose page is not in the manifest', () => {
    const site = aSite();
    const bodies = new Map(site.bodies);
    bodies.set('stranger', { schemaVersion: 5, prosemirror: { type: 'doc', content: [] } });
    const index = JSON.parse(
      fileText(renderSite({ ...site, bodies }).files, '_nix/search.json'),
    ) as SearchIndex;
    expect(index.docs).toHaveLength(site.pages.length);
  });

  it('folds accents and case', () => {
    expect(tokenize('Café NIX a')).toEqual(['cafe', 'nix']);
  });

  it('falls back to titles when the bodies would pass the cap', () => {
    // Long unique tokens reach the 2 MiB cap with far fewer words than short ones.
    const text = Array.from({ length: 50_000 }, (_, index) =>
      index.toString(36).padStart(38, 'a'),
    ).join(' ');
    const built = buildSearchIndex([{ path: '/', title: 'Home page', text }]);
    expect(built.partial).toBe(true);
    expect(Object.keys((JSON.parse(built.json) as SearchIndex).terms)).toEqual(['home', 'page']);
  });
});
