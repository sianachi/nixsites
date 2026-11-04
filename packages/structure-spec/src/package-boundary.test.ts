import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * `@nix/structure-spec` exists to be importable from anywhere - the web, `@nix/companion`, and
 * eventually nixctl and the catalog generator - without pulling in a browser, React,
 * or `@nix/api-client`. `types.ts`'s header comment states that constraint, but nothing in the
 * type system enforces it: a later wave could add a dependency and nothing would fail until
 * someone noticed a cycle or a bundle that grew. This test is that check, reading the package's
 * own manifest rather than trusting the comment to stay true.
 */
describe('the package boundary', () => {
  it('declares only zod and @nix/sheet as runtime dependencies', () => {
    const packageDir = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(readFileSync(join(packageDir, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(['@nix/sheet', 'zod']);
  });
});
