import { routes } from './routes';
import type { ViewAnswer, ViewRequest, ViewSource } from './types';

export type { ViewAnswer, ViewCompute, ViewRequest, ViewRoute, ViewSource } from './types';

/** Whether the request is one of Core's computed reads, so a caller can skip preparing a source for the rest. */
export const isComputedView = (request: Pick<ViewRequest, 'method' | 'url'>): boolean =>
  routes.some(
    (route) => route.method === request.method && route.pattern.test(request.url.pathname),
  );

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
