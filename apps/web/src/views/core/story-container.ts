import type { EffectiveSchema, Item, PropertyDefinition, View } from './container-model';
import type { ContainerData } from './use-container';

/**
 * A container and its children for a Storybook story, held in memory.
 *
 * Stories draw a view without Core, so the container's writes are answered here: a property write
 * lands on the in-memory child and reports success, which is enough for a story to show the state
 * a write moves the view into. Kept beside the views it serves rather than in the test fixtures,
 * which a story must not import.
 */
export function storyContainer(
  children: readonly Item[],
  properties: readonly PropertyDefinition[],
  overrides: Partial<ContainerData> = {},
): ContainerData {
  const schema: EffectiveSchema = {
    properties: [...properties],
    declared: [...properties],
    inherit: true,
  };
  const resolved = Promise.resolve(null);

  return {
    itemId: 'story-container',
    status: 'ready',
    error: null,
    refreshing: false,
    refreshError: null,
    locked: false,
    schema,
    views: null,
    children,
    writeError: null,
    truncated: false,
    create: () => resolved,
    setProperties: () => resolved,
    setPropertiesMany: () => Promise.resolve({ saved: 0, refused: [] }),
    setSchema: () => resolved,
    setViews: () => resolved,
    appendViewSetup: () => resolved,
    replaceViewSetup: () => resolved,
    setDefaultView: () => resolved,
    setDocumentHidden: () => resolved,
    reload: () => Promise.resolve(),
    ...overrides,
  };
}

/** One child for a story: a note in the story container, with the given values. */
export function storyItem(
  id: string,
  title: string,
  seq: number,
  properties: Record<string, unknown> = {},
  type = 'note',
): Item {
  return {
    id,
    workspaceId: 'story-workspace',
    parentId: 'story-container',
    type,
    title,
    hasChildren: false,
    seq,
    lifecycleState: 'active',
    properties,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

export function recordStoryView(kind: string, overrides: Partial<View> = {}): View {
  return {
    id: kind,
    name: 'Plans',
    kind,
    columns: [],
    groupBy: null,
    groupOrder: [],
    dateProperty: null,
    sortBy: null,
    sortDescending: false,
    mode: null,
    coverProperty: null,
    endDateProperty: null,
    cardSize: null,
    layout: null,
    filters: [],
    ...overrides,
  };
}
