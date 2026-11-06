import { defineQuery, type QueryEndpoint } from '@nix/api-client';
import { z } from 'zod';

/** What an anonymous reader gets from a public link: a note's html, or a short-lived file URL. */
export const PublicLinkSchema = z.object({
  kind: z.enum(['note', 'file']),
  title: z.string().nullish(),
  html: z.string().nullish(),
  url: z.string().nullish(),
  name: z.string().nullish(),
  mediaType: z.string().nullish(),
});

export type PublicLink = z.infer<typeof PublicLinkSchema>;

export function publicLinkByToken(token: string): QueryEndpoint<PublicLink> {
  return defineQuery({
    operation: 'links.public.get',
    path: `/public/v1/links/${encodeURIComponent(token)}`,
    schema: PublicLinkSchema,
    cacheKey: ['public-links', token],
    staleAfterMs: 0,
  });
}
