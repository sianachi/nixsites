import { describe, expect, it } from 'vitest';
import { WORKSPACE_OPERATIONS } from '@nix/structure-spec';
import { flattenToolExample, TOOL_EXAMPLES } from '@nix/structure-spec/testing';
import { workspaceToolSchema } from './tool-args.js';

/**
 * The other half of the round trip `packages/structure-spec/src/catalog/tools.test.ts` checks: a
 * typed `nix_<operation>` call's example arguments, flattened by the same TS reference
 * implementation (`flattenToolExample`),
 * must parse as a `workspaceToolSchema` this package (and `run.ts`) has never changed. This lives
 * here rather than in `@nix/structure-spec` because `workspaceToolSchema` lives here -
 * `@nix/structure-spec` depends on nothing but `zod` and `@nix/sheet`
 * (`package-boundary.test.ts`), so it cannot import this package to check the other direction.
 */
describe('flattened typed-tool examples parse as workspaceToolSchema', () => {
  for (const operation of WORKSPACE_OPERATIONS) {
    it(`accepts the flattened ${operation} example`, () => {
      const flat = flattenToolExample(operation, TOOL_EXAMPLES[operation]);
      const parsed = workspaceToolSchema.safeParse(flat);
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
    });
  }
});
