import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadFixture } from './fixture.js';
import { collectFileReferences } from './references.js';
import { renderSite, type RenderedFile } from './render.js';
import { loadPreviewRasterizer } from './theme/preview-image.js';

/**
 * Both fixtures, rendered and compared byte for byte with `src/__golden__/<fixture>/`.
 * Regenerate with `UPDATE_GOLDEN=1 pnpm --filter @nix/site-render test`.
 *
 * Text files are stored whole. Fonts, images and the stylesheet are not stored; `_nix/build.json`
 * is, and it carries every file's SHA-256, so a change to any of them still fails here. (The
 * stylesheet is left out because its colours are literal by design, and the raw-design-values
 * guard rightly refuses literal colours anywhere outside `@nix/design-tokens`.)
 */

const TEXT = /\.(html|xml|json|js|txt)$/;
const here = import.meta.dirname;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

function renderFresh(fixture: string): Promise<{ files: readonly RenderedFile[] }> {
  return loadFixture(join(here, '__fixtures__', fixture)).then(async (input) =>
    renderSite({ ...input, previews: await loadPreviewRasterizer() }),
  );
}

// Rendering is the slow part and the tests only read the result, so each fixture renders once.
const rendered = new Map<string, ReturnType<typeof renderFresh>>();
function render(fixture: string): ReturnType<typeof renderFresh> {
  let result = rendered.get(fixture);
  if (result === undefined) {
    result = renderFresh(fixture);
    rendered.set(fixture, result);
  }
  return result;
}

describe.each(['docs', 'blog'])('the %s fixture', (fixture) => {
  it('matches its golden output byte for byte', async () => {
    const { files } = await render(fixture);
    const golden = join(here, '__golden__', fixture);
    const text = files.filter((file) => TEXT.test(file.path));

    if (process.env.UPDATE_GOLDEN === '1') {
      rmSync(golden, { recursive: true, force: true });
      for (const file of text) {
        mkdirSync(dirname(join(golden, file.path)), { recursive: true });
        writeFileSync(join(golden, file.path), file.bytes);
      }
    }

    expect(existsSync(golden)).toBe(true);
    expect(
      walk(golden)
        .map((path) => relative(golden, path))
        .sort(),
    ).toEqual(text.map((file) => file.path));
    for (const file of text) {
      expect(new TextDecoder().decode(file.bytes), file.path).toBe(
        readFileSync(join(golden, file.path), 'utf8'),
      );
    }
  });

  it('renders the same bytes twice', async () => {
    const [first, second] = [await render(fixture), await renderFresh(fixture)];
    expect(
      second.files.map((file) => [file.path, Buffer.from(file.bytes).toString('base64')]),
    ).toEqual(first.files.map((file) => [file.path, Buffer.from(file.bytes).toString('base64')]));
  });

  it('uses only same-origin URLs for scripts, styles and images, and no inline script or style', async () => {
    const { files } = await render(fixture);
    for (const file of files.filter((entry) => entry.path.endsWith('.html'))) {
      const html = new TextDecoder().decode(file.bytes);
      // The one inline script element allowed is the JSON-LD data block, which never runs.
      expect(html, file.path).not.toMatch(
        /<script(?![^>]*\ssrc="\/_nix\/)(?! type="application\/ld\+json">)/,
      );
      expect(html, file.path).not.toMatch(/\sstyle=|<style/);
      expect(html, file.path).not.toMatch(/<img[^>]+src="(?!\/_nix\/assets\/)/);
      expect(html, file.path).not.toMatch(/nix-file:|X-Amz-|capability/i);
    }
  });
});

describe('the blog fixture', () => {
  it('copies only referenced images, stripped, and reports what it could not show', async () => {
    const input = await loadFixture(join(here, '__fixtures__', 'blog'));
    // Every reference but the link to an unpublished page resolves to an image or a download.
    const referenced = new Set(
      collectFileReferences(input.pages, input.bodies)
        .map((ref) => ref.fileItemId)
        .filter((id) => id !== '0199c0de-0200-7000-8000-000000000999'),
    );
    expect([...input.assets.keys(), ...(input.downloads?.keys() ?? [])].sort()).toEqual(
      [...referenced].sort(),
    );

    const site = renderSite(input);
    const assets = site.files.filter((file) => file.kind === 'asset');
    expect(assets).toHaveLength(referenced.size);
    for (const asset of assets) {
      expect(Buffer.from(asset.bytes).includes(Buffer.from('Exif\0\0'))).toBe(false);
      expect(Buffer.from(asset.bytes).includes(Buffer.from('tEXt'))).toBe(false);
    }
    // The Mermaid diagram has a capture of its current source, so it is a picture, not a loss.
    expect(site.loss.map((entry) => entry.kind).sort()).toEqual([
      'reference-flattened',
      'reference-flattened',
    ]);
    expect(
      assets
        .filter((file) => file.path.startsWith('_nix/files/'))
        .map((file) => file.mediaType)
        .sort(),
    ).toEqual(['application/pdf', 'text/plain']);
    expect(assets.map((file) => file.path)).toContainEqual(
      expect.stringMatching(/^_nix\/files\/[0-9a-f]{64}\/Desk-setup-2026\.pdf$/),
    );
    const diagram = assets.find((file) => file.path.endsWith('.svg'));
    expect(diagram?.mediaType).toBe('image/svg+xml');
    expect(new TextDecoder().decode(diagram?.bytes)).not.toMatch(/<script|foreignObject|\son\w+=/);
  });

  it('publishes code instead of a capture taken from different source', async () => {
    const input = await loadFixture(join(here, '__fixtures__', 'blog'));
    const post = '0199c0de-0200-7000-8000-000000000032';
    const body = structuredClone(input.bodies.get(post)) as {
      prosemirror: {
        content: { type: string; attrs?: { language?: string }; content?: { text: string }[] }[];
      };
    };
    const block = body.prosemirror.content.find((node) => node.attrs?.language === 'mermaid');
    const text = block?.content?.[0];
    if (text === undefined) throw new Error('The fixture has no Mermaid block.');
    text.text += '\n  Kernel --> Rootfs';
    const site = renderSite({
      ...input,
      bodies: new Map([...input.bodies, [post, body as never]]),
    });
    expect(site.files.some((file) => file.path.endsWith('.svg'))).toBe(false);
    expect(site.loss.map((entry) => entry.kind)).toContain('image-not-embedded');
  });

  it('never names the unpublished item it links to', async () => {
    const { files } = await render('blog');
    for (const file of files.filter((entry) => TEXT.test(entry.path))) {
      const text = new TextDecoder().decode(file.bytes);
      expect(text, file.path).not.toContain('0199c0de-0200-7000-8000-000000000999');
    }
  });
});
