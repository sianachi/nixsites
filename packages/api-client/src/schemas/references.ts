/** Reference resolution and backlink response shapes. */

import { z } from 'zod';
import type { components } from '../generated/api.js';
import { searchHitSchema } from './search.js';

const referenceResolutionSchema = z.object({
  id: z.uuid(),
  readable: z.boolean(),
  item: searchHitSchema.nullable(),
});

export const referencesSchema = z.object({
  references: z.array(referenceResolutionSchema),
});

export type References = z.infer<typeof referencesSchema>;

const _referenceResolutionContract = referenceResolutionSchema satisfies z.ZodType<
  components['schemas']['ReferenceResolutionResponse']
>;
void _referenceResolutionContract;

const _referencesContract = referencesSchema satisfies z.ZodType<
  components['schemas']['ReferencesResponse']
>;
void _referencesContract;

const backlinkSchema = z.object({
  source: searchHitSchema,
  occurrences: z.union([z.int(), z.string().regex(/^-?\d+$/)]),
});

export type Backlink = z.infer<typeof backlinkSchema>;

export const backlinksSchema = z.object({
  backlinks: z.array(backlinkSchema),
  limit: z.union([z.int(), z.string().regex(/^-?\d+$/)]),
  truncated: z.boolean(),
});

export type Backlinks = z.infer<typeof backlinksSchema>;

const _backlinksContract = backlinksSchema satisfies z.ZodType<
  components['schemas']['BacklinksResponse']
>;
void _backlinksContract;
