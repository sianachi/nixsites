import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TemplateInitializationEditor } from '../../templates/initialization/template-initialization-editor';
import type { TemplateInitialization, TemplateItem } from '../../templates/template-api';

const client = { query: vi.fn<(endpoint: { path: string }) => Promise<{ title: string }>>() };
vi.mock('@nix/web-platform/api/api-client-provider', () => ({ useApiClient: () => client }));
vi.mock('@nix/web-workspaces/workspaces/use-workspace-assignable-principals', () => ({
  useWorkspaceAssignablePrincipals: () => [],
}));

const FIRST = '10000000-0000-4000-8000-000000000001';
const SECOND = '10000000-0000-4000-8000-000000000002';
const root = { sourceId: 'root', title: 'Root', children: [] } as unknown as TemplateItem;
const initialization = (ids: readonly string[]): TemplateInitialization => ({
  version: 1,
  inputs: [],
  rules: [],
  references: ids.map((sourceItemId) => ({ sourceItemId, policy: 'retain' })),
});
const editor = (ids: readonly string[]) => (
  <TemplateInitializationEditor
    root={root}
    initialization={initialization(ids)}
    itemOptions={[]}
    onChange={() => undefined}
  />
);

beforeEach(() => {
  client.query.mockReset();
  client.query.mockResolvedValue({ title: 'A page' });
});

describe('reference titles', () => {
  it('are requested again only when the referenced items change', async () => {
    const view = render(editor([FIRST]));
    await waitFor(() => {
      expect(client.query).toHaveBeenCalledTimes(1);
    });

    // An edit elsewhere in the form hands over a new array holding the same item.
    view.rerender(editor([FIRST]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.query).toHaveBeenCalledTimes(1);

    view.rerender(editor([FIRST, SECOND]));
    await waitFor(() => {
      expect(client.query).toHaveBeenCalledTimes(3);
    });
    expect(client.query.mock.calls.at(-1)?.[0].path).toContain(SECOND);
  });
});
