import { z } from 'zod';

const creationTitleState = z.object({ initialTitle: z.string().trim().min(1).max(240) });

export function creationTitleFrom(state: unknown): string | null {
  return creationTitleState.safeParse(state).data?.initialTitle ?? null;
}
