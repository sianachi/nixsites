import { z } from 'zod';
import { browserStorage } from '@nix/web-foundation/lib/browser-storage';
import type { GraphRepresentation } from './graph-representations';

const schema = z.object({
  representation: z.enum(['radial', 'focused', 'hierarchy', 'clusters', 'chronological']),
  focusId: z.string().nullable(),
  distance: z.number().int().min(1).max(5),
});
const stored = z.record(z.string(), schema);
const KEY = 'nix.graph-presentation';
export interface GraphPresentation {
  readonly representation: GraphRepresentation;
  readonly focusId: string | null;
  readonly distance: number;
}
export const DEFAULT_PRESENTATION: GraphPresentation = {
  representation: 'radial',
  focusId: null,
  distance: 1,
};
function readAll(): z.infer<typeof stored> {
  try {
    const parsed = stored.safeParse(JSON.parse(browserStorage()?.getItem(KEY) ?? '{}'));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}
export function readGraphPresentation(workspaceId: string | undefined): GraphPresentation {
  return workspaceId === undefined
    ? DEFAULT_PRESENTATION
    : (readAll()[workspaceId] ?? DEFAULT_PRESENTATION);
}
export function writeGraphPresentation(
  workspaceId: string | undefined,
  value: GraphPresentation,
): void {
  if (workspaceId === undefined) return;
  try {
    browserStorage()?.setItem(KEY, JSON.stringify({ ...readAll(), [workspaceId]: value }));
  } catch {
    /* Device preferences are optional. */
  }
}
