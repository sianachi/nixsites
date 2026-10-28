import { describe, expect, it } from 'vitest';

import { contrast } from './contrast.test-helper.js';

import { SITE_PALETTE, type SiteGround } from './site.js';
import { parseCustomProperties, resolveProperty, splitByGround, themeCss } from './theme-sheet.js';

/**
 * The site palette against the token sheet. Without this, `site.ts` is a hand copy of the colours
 * that drifts silently; with it, every role names its token and the contrast the theme relies on
 * is computed rather than assumed.
 */

const grounds = splitByGround(themeCss);
const light = parseCustomProperties(grounds.light);
// The dark ground overrides roles only; ramps resolve through the light declarations.
const dark = new Map([...light, ...parseCustomProperties(grounds.dark)]);

type FlatRole = Exclude<keyof SiteGround, 'syntax' | 'series'>;

const SOURCES: Record<'light' | 'dark', Record<FlatRole, string>> = {
  light: {
    ground: 'color-neutral-100',
    surface: 'color-surface',
    text: 'color-text',
    muted: 'color-muted',
    border: 'color-neutral-300',
    link: 'color-accent-text',
    code: 'color-neutral-200',
    mark: 'color-accent-200',
    accent: 'color-accent-fill',
    onAccent: 'color-neutral-100',
  },
  dark: {
    ground: 'color-bg',
    surface: 'color-surface',
    text: 'color-text',
    muted: 'color-muted',
    border: 'color-neutral-800',
    link: 'color-accent-text',
    code: 'color-surface',
    mark: 'color-accent-800',
    accent: 'color-accent-fill',
    onAccent: 'color-bg',
  },
};

const SYNTAX_SOURCES: Record<'light' | 'dark', Record<keyof SiteGround['syntax'], string>> = {
  light: {
    keyword: 'color-series-4',
    string: 'color-series-3',
    number: 'color-series-5',
    comment: 'color-muted',
    title: 'color-accent-700',
    type: 'color-accent-800',
  },
  dark: {
    keyword: 'color-series-1',
    string: 'color-series-3',
    number: 'color-series-5',
    comment: 'color-muted',
    title: 'color-accent-300',
    type: 'color-accent-200',
  },
};

const FLAT_ROLES = Object.keys(SOURCES.light) as FlatRole[];
const SYNTAX_ROLES = Object.keys(SYNTAX_SOURCES.light) as (keyof SiteGround['syntax'])[];

describe.each([
  ['light', light],
  ['dark', dark],
] as const)('the %s site ground', (name: 'light' | 'dark', sheet: ReadonlyMap<string, string>) => {
  const ground = SITE_PALETTE[name];

  it('takes every role from the token sheet', () => {
    for (const [role, token] of Object.entries(SOURCES[name])) {
      expect(ground[role as FlatRole], role).toBe(resolveProperty(sheet, token));
    }
    for (const [role, token] of Object.entries(SYNTAX_SOURCES[name])) {
      expect(ground.syntax[role as keyof SiteGround['syntax']], role).toBe(
        resolveProperty(sheet, token),
      );
    }
    const series = [1, 2, 3, 4, 5, 6].map((index) =>
      resolveProperty(sheet, `color-series-${String(index)}`),
    );
    expect(ground.series).toEqual([...series, resolveProperty(sheet, 'color-muted')]);
  });

  it('keeps body text, quiet text and links at 4.5:1 or better', () => {
    for (const role of ['text', 'muted', 'link'] as const) {
      expect(contrast(ground[role], ground.ground), role).toBeGreaterThanOrEqual(4.5);
      expect(contrast(ground[role], ground.surface), role).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(ground.text, ground.code)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(ground.text, ground.mark)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(ground.onAccent, ground.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps every syntax colour readable on the code ground', () => {
    for (const role of SYNTAX_ROLES) {
      expect(contrast(ground.syntax[role], ground.code), role).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('is literal colour throughout, because the stylesheet is generated from it', () => {
    const values = [
      ...FLAT_ROLES.map((role) => ground[role]),
      ...SYNTAX_ROLES.map((role) => ground.syntax[role]),
      ...ground.series,
    ];
    for (const value of values) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
