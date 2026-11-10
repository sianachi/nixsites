import { z } from 'zod';

import { LIMITS } from '../catalog/tables.js';
import { fieldSpecSchema } from './field.js';
import { viewSpecSchema } from './view.js';

/**
 * Any JSON value, for a field value a pet supplies on an entry or a template input it fills.
 * Recursive, so it is declared with `z.lazy`; the TS type is written out by hand because Zod
 * cannot infer a recursive type through `z.infer` without one.
 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/**
 * The ten recipes a pet may create structure from (architecture 2.3). `drive`
 * exists in `STRUCTURED_RECIPES` for the web wizard but is excluded here: a recipe's own list of
 * refusals (architecture 1.3) keeps them out of the pet surface by construction rather than by a
 * runtime check downstream. Kept as a plain tuple, not derived from `STRUCTURED_RECIPES`, for the
 * same reason `FIELD_SPEC_TYPES` is in `field.ts`; `spec.test.ts` ties the two lists together so a
 * new recipe added to the wizard and forgotten here fails a test instead of silently never
 * reaching the pet.
 */
export const STRUCTURED_SPEC_RECIPE_IDS = [
  'form',
  'interactive-form',
  'board',
  'sheet',
  'list',
  'calendar',
  'timeline',
  'gallery',
  'habit-tracker',
  'query',
  'chart',
  'checklist',
  'matrix',
  'outline',
] as const;

export const structuredRecipeIdSchema = z.enum(STRUCTURED_SPEC_RECIPE_IDS);

export const structuredSpecSchema = z
  .object({
    recipe: structuredRecipeIdSchema,
    fields: z.array(fieldSpecSchema).max(30),
    views: z.array(viewSpecSchema).max(LIMITS.viewsPerNode).optional(),
    inherit: z.boolean().default(true),
  })
  .strict();
export type StructuredSpec = z.infer<typeof structuredSpecSchema>;

export const viewSetupSpecSchema = z
  .object({
    fields: z.array(fieldSpecSchema).max(20).optional(),
    views: z.array(viewSpecSchema).min(1).max(LIMITS.viewsPerAddView),
  })
  .strict();
export type ViewSetupSpec = z.infer<typeof viewSetupSpecSchema>;

const entrySpecSchema = z
  .object({
    title: z.string().min(1).max(240),
    values: z
      .record(z.string(), jsonValueSchema)
      .describe('Values are keyed by field key (see nix_read_structure), never by field label.')
      .optional(),
    markdown: z.string().max(2000).optional(),
    sample: z.boolean().optional(),
  })
  .strict();
export type EntrySpec = z.infer<typeof entrySpecSchema>;

export const entriesSpecSchema = z
  .object({
    entries: z.array(entrySpecSchema).min(1).max(25),
  })
  .strict();
export type EntriesSpec = z.infer<typeof entriesSpecSchema>;

export const applySpecSchema = z
  .object({
    inputs: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type ApplySpec = z.infer<typeof applySpecSchema>;
