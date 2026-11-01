import { describe, expect, it } from 'vitest';

import { prepareDownload } from './downloads.js';
import { SiteManifestError } from './manifest.js';
import { renderSite, type RenderSiteInput } from './render.js';
import { aPage, aSite, fileText } from './site.test-helper.js';

/** The custom layout: templates, stylesheets and scripts from the theme page's attached files. */

const encoder = new TextEncoder();

function customSite(files: Record<string, string>, template = true): RenderSiteInput {
  const site = aSite();
  const ids = Object.keys(files).map((_, index) => `f${String(index)}`);
  const theme = aPage({
    itemId: 'theme',
    path: '/theme/',
    title: 'Theme',
    parentItemId: 'root',
    ordinal: 6,
    properties: { files: ids.map((id) => `nix-file:${id}`) },
  });
  return {
    ...site,
    manifest: {
      ...site.manifest,
      layout: 'custom',
      pageCount: site.pages.length + 1,
      settings: { ...site.manifest.settings, themeItemId: template ? 'theme' : null },
    },
    pages: [...site.pages, theme],
    downloads: new Map(
      Object.values(files).map((text, index) => [
        `f${String(index)}`,
        prepareDownload(encoder.encode(text), 'text/plain', 'theme.txt'),
      ]),
    ),
    fileNames: new Map(Object.keys(files).map((name, index) => [`f${String(index)}`, name])),
  };
}

const LAYOUT =
  '<!doctype html><html><head>{{ nix.seo | raw }}</head><body class="mine">{{ nix.body | raw }}</body></html>';

describe('the custom layout', () => {
  it('fills the templates with workspace data and publishes the theme files', () => {
    const { files } = renderSite(
      customSite({
        'layout.liquid': LAYOUT,
        'home.liquid':
          '<h1>{{ site.name }}</h1>{% assign posts = site.pages | where: "path", "/posts/" | first %}{% for entry in posts.entries %}<p>{{ entry.title }} {{ entry.date | date_label }}</p>{% endfor %}{{ page.content | raw }}{% render "card", title: "<b>x</b>" %}',
        'card.liquid': '<i>{{ title }}</i>',
        'site.css': 'body{color:red}',
        'pets.js': 'console.log(1)',
      }),
    );
    const home = fileText(files, 'index.html');
    expect(home).toContain('<body class="mine">');
    expect(home).toContain('<p>Second post 1 May 2026</p><p>First post 1 March 2026</p>');
    expect(home).toContain('<p>Welcome home.</p>');
    // Output is escaped unless the template asks for raw.
    expect(home).toContain('<i>&lt;b&gt;x&lt;/b&gt;</i>');
    expect(home).toMatch(
      /<link rel="stylesheet" href="\/_nix\/theme\/[0-9a-f]{16}\/own\/site\.css">/,
    );
    expect(home).toMatch(/<script src="\/_nix\/theme\/[0-9a-f]{16}\/own\/pets\.js" defer>/);
    // nix.seo leaves out the built-in stylesheet.
    expect(home).not.toMatch(/\/site\.css">\n<script src="[^"]*\/site\.js">/);
    expect(home).toContain('<link rel="canonical"');

    const css = files.find((file) => file.path.endsWith('/own/site.css'));
    expect(css?.kind).toBe('build');
    // Pages without their own template keep the built-in body inside the custom layout.
    expect(fileText(files, 'posts/first/index.html')).toContain('<body class="mine">');
    // The theme page is the source, not a page; and the build asks to be sandboxed.
    expect(files.some((file) => file.path.startsWith('theme/'))).toBe(false);
    expect(fileText(files, 'sitemap.xml')).not.toContain('/theme/');
    expect(JSON.parse(fileText(files, '_nix/build.json'))).toMatchObject({ sandboxed: true });
  });

  it('falls back to the built-in shell without a layout template', () => {
    const { files } = renderSite(customSite({ 'home.liquid': '<p>Mine</p>' }));
    const home = fileText(files, 'index.html');
    expect(home).toContain('<main id="content" class="nix-main" tabindex="-1">\n<p>Mine</p>');
    expect(home).toContain('nix-layout-custom');
  });

  it('fails the build with the template error', () => {
    expect(() => renderSite(customSite({ 'home.liquid': '{% for x in %}' }))).toThrow(
      /The theme's home template failed/,
    );
  });

  it('refuses a custom site without a theme page', () => {
    expect(() => renderSite(customSite({}, false))).toThrow(SiteManifestError);
  });

  it('leaves built-in sites unsandboxed', () => {
    const { files } = renderSite(aSite());
    expect(JSON.parse(fileText(files, '_nix/build.json'))).not.toHaveProperty('sandboxed');
  });
});
