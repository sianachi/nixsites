// @vitest-environment node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Crawlers that build a link preview (Reddit, X, Slack, Discord, LinkedIn) read index.html and do
 * not run the app. These tags are the card for the public pages. Published sites draw their own.
 */

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const html = readFileSync(join(appRoot, 'index.html'), 'utf8');

const DESCRIPTION =
  'Nix is a free, open-source workspace where people and their AI agents work together: notes, tasks, habits, calendars, spreadsheets, files and automations in one place.';
const TITLE = 'Where people and their AI agents work together.';
const IMAGE = 'https://nixsites.com/nix-og.png';
const PAGE = 'https://nixsites.com/';
const ALT = 'Nix, where people and their AI agents work together.';

function meta(key: string): string {
  const pattern = new RegExp(
    `<meta\\s+(?:name|property)="${key}"\\s+content="([^"]*)"\\s*/?>`,
    'u',
  );
  const value = pattern.exec(html)?.[1];
  if (value === undefined) {
    throw new Error(`no meta ${key}`);
  }
  return value;
}

function pngDimensions(path: string): readonly [number, number] {
  const bytes = readFileSync(path);
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe('link previews for the public pages', () => {
  it('describes the page for Open Graph and Twitter cards', () => {
    expect(meta('description')).toBe(DESCRIPTION);
    expect(meta('og:type')).toBe('website');
    expect(meta('og:site_name')).toBe('Nix');
    expect(meta('og:title')).toBe(TITLE);
    expect(meta('og:description')).toBe(DESCRIPTION);
    expect(meta('og:url')).toBe(PAGE);
    expect(meta('og:image')).toBe(IMAGE);
    expect(meta('og:image:width')).toBe('1200');
    expect(meta('og:image:height')).toBe('630');
    expect(meta('og:image:alt')).toBe(ALT);
    expect(meta('twitter:card')).toBe('summary_large_image');
    expect(meta('twitter:title')).toBe(TITLE);
    expect(meta('twitter:description')).toBe(DESCRIPTION);
    expect(meta('twitter:url')).toBe(PAGE);
    expect(meta('twitter:image')).toBe(IMAGE);
    expect(meta('twitter:image:alt')).toBe(ALT);
  });

  it('ships the preview image at the path the card names, 1200 by 630', () => {
    const path = new URL(IMAGE).pathname;
    expect(path).toBe('/nix-og.png');
    expect(pngDimensions(join(appRoot, 'public', 'nix-og.png'))).toEqual([1200, 630]);
  });
});
