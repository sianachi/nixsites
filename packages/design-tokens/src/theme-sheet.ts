/**
 * Reading the token sheet back, for tests that assert against what it actually declares.
 *
 * **Extracted so there is one parser rather than one per test file.** Both readers below encode a
 * bug that was live once and would be live again in a second copy - `splitByGround` in particular
 * exists because a naive read of this sheet reports dark values for light roles. A test that
 * silently asserts the wrong ground passes and means nothing, which is the failure mode a
 * duplicated parser reintroduces at the first copy-paste.
 *
 * Test-only, and deliberately not in the package's `exports`: nothing at runtime should be parsing
 * CSS to find out what a colour is.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');

export const themeCss: string = readFileSync(join(packageDir, 'src', 'theme.css'), 'utf8');

/**
 * The span of the block whose opening brace follows `from`, braces balanced.
 *
 * Returned as a half-open range so a caller can either keep it or cut it out.
 */
function blockAt(css: string, from: number): { start: number; end: number } {
  let index = css.indexOf('{', from);
  const start = index;
  let depth = 0;

  while (index < css.length) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
    index += 1;
  }

  return { start, end: index + 1 };
}

/**
 * Splits the sheet into what each ground declares.
 *
 * **Both dark blocks are cut out of the light ground, not just the media query.** The sheet states
 * the dark ground twice - once for the system preference and once for an explicit choice - and the
 * second one is a plain `:root` rule that a naive read counts as light. Since it comes last, its
 * declarations win the map, and a light-ground assertion silently reads a dark value.
 *
 * That was live for as long as both grounds happened to override the same properties: a test
 * comparing two roles would compare their dark values and pass, meaning nothing. It surfaced when
 * the two grounds started declaring shadows of different *shapes* rather than different colours.
 */
export function splitByGround(css: string): { light: string; dark: string } {
  // Strip comments first so commented-out declarations never count.
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

  const mediaStart = withoutComments.indexOf('@media (prefers-color-scheme: dark)');
  const attributeStart = withoutComments.search(/:root\[data-theme=['"]dark['"]\]/);

  let light = withoutComments;
  let dark = '';

  // Cut from the back so the earlier offset stays valid.
  for (const start of [mediaStart, attributeStart].sort((a, b) => b - a)) {
    if (start === -1) {
      continue;
    }

    const block = blockAt(light, start);
    if (start === mediaStart) {
      dark = light.slice(block.start, block.end);
    }

    light = light.slice(0, start) + light.slice(block.end);
  }

  return { light, dark };
}

/** Every custom property declared in one ground, by name (without the leading dashes). */
export function parseCustomProperties(css: string): Map<string, string> {
  const declarations = new Map<string, string>();
  const pattern = /--([\w-]+)\s*:\s*([^;]+);/g;
  for (const match of css.matchAll(pattern)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) {
      declarations.set(name, value.trim());
    }
  }
  return declarations;
}

/**
 * Follows `var(--x)` chains down to the literal a ground finally states.
 *
 * The semantic roles are declared as references - `--color-muted: var(--color-neutral-700)` - so a
 * test asking what colour a role *is* has to resolve the chain rather than assert on the reference
 * text, which would pass whatever the ramp step underneath it changed to.
 */
export function resolveProperty(properties: ReadonlyMap<string, string>, name: string): string {
  const seen = new Set<string>();
  let current = name;

  for (;;) {
    if (seen.has(current)) {
      throw new Error(`--${name} resolves in a cycle through --${current}.`);
    }
    seen.add(current);

    const value = properties.get(current);
    if (value === undefined) {
      throw new Error(`theme.css does not declare --${current}`);
    }

    const reference = /^var\(\s*--([\w-]+)\s*\)$/.exec(value);
    if (reference?.[1] === undefined) {
      return value;
    }

    current = reference[1];
  }
}
