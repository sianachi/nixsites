import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '@nix/api-client';
import { z } from 'zod';

const PublicFormLinkSchema = z.object({
  published: z.boolean(),
  url: z.string().nullable(),
  publishedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});

export type PublicFormLink = z.infer<typeof PublicFormLinkSchema>;

const linkKey = (itemId: string, viewId: string): readonly string[] => [
  'items',
  itemId,
  'views',
  viewId,
  'public-link',
];

function path(itemId: string, viewId: string): string {
  return `/api/v1/items/${itemId}/views/${encodeURIComponent(viewId)}/public-link`;
}

export function publicFormStatus(itemId: string, viewId: string): QueryEndpoint<PublicFormLink> {
  return defineQuery({
    operation: 'forms.publicLink.status',
    path: path(itemId, viewId),
    schema: PublicFormLinkSchema,
    cacheKey: linkKey(itemId, viewId),
    staleAfterMs: 0,
  });
}

export function changePublicFormStatus(
  itemId: string,
  viewId: string,
  method: 'PUT' | 'DELETE',
): CommandEndpoint<PublicFormLink> {
  return defineCommand({
    operation: method === 'PUT' ? 'forms.publicLink.publish' : 'forms.publicLink.revoke',
    method,
    path: path(itemId, viewId),
    schema: PublicFormLinkSchema,
    invalidates: [linkKey(itemId, viewId)],
  });
}
