import { useState, type ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { createNixClient, type TemplateInitialization } from '@nix/api-client';
import type { NixClient, Workspace } from '@nix/api-client';
import { within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import type { WorkspaceLoadState } from '../workspaces/workspace-context';
import { WorkspaceProvider } from '../workspaces/workspace-context';
import { TemplateInitializationEditor } from './initialization/template-initialization-editor';
import type { TemplateItem } from './template-api';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOT = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';

export default { title: 'Nix/Templates/Setup and portability', parameters: { layout: 'padded' } };

const workspace = {
  id: WORKSPACE,
  name: 'Northstar',
  versionRetentionDays: 90,
  storageQuotaBytes: '10737418240',
  createdAt: '2026-09-01T09:00:00Z',
  kind: 'team',
  canRename: true,
  canManageMembers: true,
  canLeave: true,
  canUseDailyNotes: true,
  pendingInvitationId: null,
  lifecycleState: 'active',
  archivedAt: null,
} as unknown as Workspace;

const workspaceState = {
  status: 'ready',
  workspaces: [workspace],
  error: null,
  reload: () => undefined,
  workspaceCreated: () => undefined,
  workspaceUpdated: () => undefined,
  workspaceRemoved: () => undefined,
} as WorkspaceLoadState & {
  readonly reload: () => void;
  readonly workspaceCreated: (workspace: Workspace) => void;
  readonly workspaceUpdated: (workspace: Workspace) => void;
  readonly workspaceRemoved: (workspaceId: string) => void;
};

const previewClient = {
  ...createNixClient({
    baseUrl: 'http://nix.invalid',
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
  }),
  async *paginate<T>() {
    await Promise.resolve();
    yield {
      subjectType: 'principal',
      subjectId: OWNER,
      subjectDisplayName: 'Alex Morgan',
      email: 'alex@example.test',
      role: 'owner',
      grantedAt: '2026-09-01T09:00:00Z',
      canChangeRole: false,
      canRemove: false,
      assignableRoles: [],
    } as T;
  },
} as NixClient;

const root: TemplateItem = {
  sourceId: ROOT,
  itemType: 'note',
  title: 'Product launch',
  seq: '1',
  properties: { due_date: '2026-10-20', status: 'Open' },
  schema: {
    properties: [
      {
        key: 'due_date',
        label: 'Due date',
        type: 'date',
        options: [],
        required: false,
        expression: null,
        aggregate: null,
        source: null,
        choiceSource: null,
      },
      {
        key: 'status',
        label: 'Status',
        type: 'select',
        options: ['Open', 'Done'],
        required: false,
        expression: null,
        aggregate: null,
        source: null,
        choiceSource: null,
      },
    ],
    declared: [],
    inherit: false,
  },
  views: null,
  hasBody: true,
  recurrence: null,
  children: [],
};

const initial: TemplateInitialization = {
  version: 1,
  inputs: [
    {
      key: 'project_name',
      label: 'Project name',
      type: 'text',
      required: true,
      defaultValue: 'Northstar launch',
    },
    {
      key: 'start_date',
      label: 'Start date',
      type: 'date',
      required: true,
      defaultValue: '2026-09-20',
    },
    { key: 'lead', label: 'Project lead', type: 'member', required: true, defaultValue: OWNER },
    {
      key: 'related_item',
      label: 'Related item',
      type: 'item',
      required: false,
      defaultValue: null,
    },
  ],
  rules: [
    {
      sourceId: ROOT,
      propertyKey: 'due_date',
      kind: 'relativeDate',
      inputKey: 'start_date',
      offsetDays: 30,
      timeOfDay: null,
      timeZone: null,
    },
    { sourceId: ROOT, propertyKey: 'status', kind: 'set', value: 'Open' },
    {
      sourceId: ROOT,
      propertyKey: 'recurrence.until',
      kind: 'relativeDate',
      inputKey: 'start_date',
      offsetDays: 90,
      timeOfDay: null,
      timeZone: null,
    },
  ],
  references: [],
};

function Example(): ReactElement {
  const [initialization, setInitialization] = useState(initial);
  return (
    <MemoryRouter initialEntries={[`/w/${WORKSPACE}`]}>
      <Routes>
        <Route
          path="/w/:workspaceId"
          element={
            <WorkspaceProvider state={workspaceState}>
              <TemplateInitializationEditor
                root={root}
                initialization={initialization}
                itemOptions={[]}
                onChange={setInitialization}
              />
            </WorkspaceProvider>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

export const CompleteSetup = {
  render: (): ReactElement => (
    <ApiClientOverrideProvider client={previewClient}>
      <div className="mx-auto max-w-4xl">
        <Example />
      </div>
    </ApiClientOverrideProvider>
  ),
};

export const DarkCompleteSetup = { ...CompleteSetup, globals: { ground: 'dark' } };

export const SmallScreenSetup = {
  render: (): ReactElement => (
    <ApiClientOverrideProvider client={previewClient}>
      <section aria-label="Small screen template setup" className="w-60 max-w-full p-3">
        <Example />
      </section>
    </ApiClientOverrideProvider>
  ),
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    const setup = canvas.getByRole('region', { name: 'Small screen template setup' });
    await document.fonts.ready;
    if (setup.scrollWidth > setup.clientWidth) {
      throw new Error('Template setup questions and rules must fit within a small screen.');
    }
    for (const checkbox of canvas.getAllByRole('checkbox', { name: 'Set a time and time zone' })) {
      await userEvent.click(checkbox);
    }
    await userEvent.click(canvas.getByRole('button', { name: 'Add question' }));
    if (setup.scrollWidth > setup.clientWidth) {
      throw new Error('Adding questions and date controls must preserve the small screen layout.');
    }
  },
};

export const DarkSmallScreenSetup = { ...SmallScreenSetup, globals: { ground: 'dark' } };
