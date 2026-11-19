import { z } from 'zod';
import manifest from './pet-capabilities.json' with { type: 'json' };

const mode = z.enum(['read', 'review', 'routine', 'human', 'internal']);
const definitions = z
  .record(
    z.string(),
    z.union([
      z.strictObject({
        mode,
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        path: z.string().startsWith('/api/v1/'),
        executor: z.literal('nix.action').optional(),
      }),
      z.strictObject({
        mode,
        editor: z.enum(['canvas', 'note', 'sheet']),
        executor: z.string().optional(),
      }),
    ]),
  )
  .parse(manifest);

export type PetCapability = (typeof definitions)[string];

/** The manifest is a catalog. Core rechecks the request, scope and approval independently. */
export function petCapability(id: string): Readonly<PetCapability> | undefined {
  return Object.hasOwn(definitions, id) ? definitions[id] : undefined;
}

export function petCapabilityIds(): string[] {
  return Object.keys(definitions);
}
