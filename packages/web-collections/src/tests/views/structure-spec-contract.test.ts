import { describe, expect, it } from 'vitest';

import {
  STRUCTURED_RECIPES,
  type StructureFilter,
  type StructureForm,
  type StructureProperty,
  type StructureSchema,
  type StructureView,
} from '@nix/structure-spec';

import type {
  EffectiveSchema,
  InteractiveFormDefinition,
  PropertyDefinition,
  View,
  ViewFilterRule,
} from '../../core/container-model';

/**
 * The compile-time tie between `@nix/structure-spec`'s structural types and this app's own,
 * Zod-parsed ones.
 *
 * `@nix/structure-spec` may depend only on `zod` and `@nix/sheet` (task 0.3 of
 * `docs/plans/pet-structure-consult-plan.md`; see
 * `docs/adr/0050-companion-structure-tools-compile-declarative-specs.md`), so it cannot import
 * `container-model.ts`'s types directly - they are tied to `@nix/api-client`'s generated
 * contract. Instead it declares its own `StructureProperty`, `StructureView` and their form and
 * filter parts, shaped by hand to match.
 *
 * Each pair below is assigned both ways, which proves mutual assignability: every field one side
 * declares exists, compatibly typed, on the other. That is a real guard - a renamed or narrowed
 * field on either side fails `pnpm --filter @nix/web typecheck` here rather than surfacing later
 * as a silent shape mismatch - but it is not exact type equality: a field added as *optional* to
 * one side only would still assign both ways and would not be caught here. `StructureSchema` is
 * narrower on purpose (it omits `EffectiveSchema`'s `declared`), so it ties to a `Pick` of the web
 * type instead of the whole of it.
 */
function tiesBothWays() {
  const structureProperty = {} as StructureProperty;
  const webProperty: PropertyDefinition = structureProperty;
  const backAgain: StructureProperty = webProperty;

  const structureView = {} as StructureView;
  const webView: View = structureView;
  const viewBackAgain: StructureView = webView;

  const structureForm = {} as StructureForm;
  const webForm: InteractiveFormDefinition = structureForm;
  const formBackAgain: StructureForm = webForm;

  const structureFilter = {} as StructureFilter;
  const webFilter: ViewFilterRule = structureFilter;
  const filterBackAgain: StructureFilter = webFilter;

  const structureSchema = {} as StructureSchema;
  const webSchema: Pick<EffectiveSchema, 'properties' | 'inherit'> = structureSchema;
  const schemaBackAgain: StructureSchema = webSchema;

  return { backAgain, viewBackAgain, formBackAgain, filterBackAgain, schemaBackAgain };
}
void tiesBothWays;

describe('the structure-spec contract tie', () => {
  it('carries every recipe the creation studio and the pet share', () => {
    expect(STRUCTURED_RECIPES.length).toBe(16);
  });
});
