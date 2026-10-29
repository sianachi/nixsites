import { buildCatalog } from '@nix/structure-spec';
import { describe, expect, it } from 'vitest';

import { VIEW_KINDS } from '@nix/web-views/core/view-kinds';

/**
 * The pet's capability catalog offers every view kind except `drive` and `finance` (studio-only
 * surfaces the pet may never build). This test ties the catalog's view kinds back to the web wizard's own `VIEW_KINDS`, so a kind added to one
 * and forgotten in the other fails a test instead of drifting: the pet either offers a kind the
 * app cannot render, or never learns about one the app just grew.
 */
describe('the capability catalog agrees with VIEW_KINDS', () => {
  it('names every view kind except drive and finance', () => {
    const catalog = buildCatalog();
    const catalogKinds = new Set(catalog.viewKinds.map((kind) => kind.kind));

    const webKinds = new Set(
      VIEW_KINDS.map((descriptor) => descriptor.kind).filter(
        (kind) => kind !== 'drive' && kind !== 'finance',
      ),
    );

    expect(catalogKinds).toEqual(webKinds);
  });
});
