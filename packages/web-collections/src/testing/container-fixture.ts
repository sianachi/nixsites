import type { ContainerViews, View } from '../core/container-model';
import { DOCUMENT_VIEW } from '../core/container-model';
import type { ContainerData } from '../core/use-container';

/**
 * A container, for a test that cares about one thing in it.
 *
 * **Five test files used to hand-build the whole of `ContainerData`.** They were the full type
 * rather than a partial, which is the good half - adding a member broke all five at compile time
 * rather than silently leaving them stale. The bad half was that adding a member meant editing all
 * five, and every one of them spelled the defaults slightly differently.
 *
 * Kept as a factory rather than a shared constant because a test that mutates a shared object
 * fails a different test, in a different file, in an order-dependent way.
 */
export function aContainer(overrides: Partial<ContainerData> = {}): ContainerData {
  return {
    itemId: 'container-1',
    status: 'ready',
    error: null,
    refreshing: false,
    refreshError: null,
    locked: false,
    schema: null,
    views: null,
    children: [],
    writeError: null,
    truncated: false,
    create: () => Promise.resolve(null),
    setProperties: () => Promise.resolve(null),
    setPropertiesMany: () => Promise.resolve({ saved: 0, refused: [] }),
    setSchema: () => Promise.resolve(null),
    setViews: () => Promise.resolve(null),
    appendViewSetup: () => Promise.resolve(null),
    replaceViewSetup: () => Promise.resolve(null),
    setDefaultView: () => Promise.resolve(null),
    setDocumentHidden: () => Promise.resolve(null),
    reload: () => Promise.resolve(),
    ...overrides,
  };
}

/**
 * A view set.
 *
 * The default is the document unless a test says otherwise, which is what an item nobody has
 * configured actually reports.
 */
export function views(
  offered: readonly View[],
  overrides: Partial<ContainerViews> = {},
): ContainerViews {
  return {
    views: [...offered],
    unrenderable: [],
    default: DOCUMENT_VIEW,
    hideDocument: false,
    ...overrides,
  };
}
