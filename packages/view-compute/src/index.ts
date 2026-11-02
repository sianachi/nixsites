import { routes } from './routes';
import type { ViewAnswer, ViewRequest, ViewSource } from './types';

export type { ViewAnswer, ViewCompute, ViewRequest, ViewRoute, ViewSource } from './types';

/** Answers one of Core's computed reads from the synced copy, or null when it cannot. */
export async function computeView(
  source: ViewSource,
  request: ViewRequest,
): Promise<ViewAnswer | null> {
  for (const route of routes) {
    if (route.method !== request.method) continue;
    const match = route.pattern.exec(request.url.pathname);
    if (match !== null) return route.compute(source, request, match);
  }
  return null;
}
