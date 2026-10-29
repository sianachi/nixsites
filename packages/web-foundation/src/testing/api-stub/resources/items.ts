/** Item fixtures and contracts exposed by the Core stub. */
export interface StubItem {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly type: string;
  readonly parentId: string | null;
  readonly hasChildren: boolean;
  readonly seq: number;
  readonly lifecycleState: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const STUB_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';

export function item(overrides: Partial<StubItem> & { id: string; title: string }): StubItem {
  return {
    workspaceId: STUB_WORKSPACE_ID,
    type: 'note',
    parentId: null,
    hasChildren: false,
    seq: 1000,
    lifecycleState: 'active',
    properties: { title: overrides.title },
    createdAt: '2026-07-27T09:00:00.000Z',
    updatedAt: '2026-07-27T09:00:00.000Z',
    ...overrides,
  };
}
