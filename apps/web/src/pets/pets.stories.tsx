import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Text } from '@nix/ui';
import { petCatalog } from './catalog';
import { PetAvatar, petAnimationStates, type PetAnimationState } from './pet-avatar';
import type { NixClient, PetProfile, Workspace } from '@nix/api-client';
import { PetSettingsEditor } from './pet-settings-section';
import { PetWorkTools } from './work-tools/pet-work-tools';
import { writeActionReceipt } from './action-receipts';
import { createNixClient, petConnectionSchema } from '@nix/api-client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { WorkspaceProvider, type WorkspaceLoadState } from '../workspaces/workspace-context';
import { PetCompanion } from './pet-companion';
import { PetPage } from '../pages/pet-page';
import { PetHistory } from './pet-history';
import { PetChatViewport } from './pet-chat-viewport';
import { PetMessageText } from './pet-message-text';
import { PetStructurePreview } from './pet-structure-preview';
import type { PreviewModel } from '@nix/structure-spec';
import * as Y from 'yjs';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import { nixSchema } from '@nix/editor-schema';
import { markdownToDocument } from '@nix/markdown';
import { within } from '@testing-library/dom';

export default { title: 'Nix/Companions', parameters: { layout: 'padded' } };

export const AnimationStates = {
  render: (): ReactElement => (
    <div className="grid grid-cols-3 gap-4">
      {petCatalog.flatMap(({ appearance }) =>
        petAnimationStates.map((state) => (
          <div key={`${appearance}:${state}`} className="flex flex-col items-center gap-2">
            <PetAvatar
              appearance={appearance}
              state={state}
              motion="reduced"
              label={`${appearance}: ${state}`}
            />
            <Text variant="note">
              {appearance}: {state}
            </Text>
          </div>
        )),
      )}
    </div>
  ),
};

const settingsClient: NixClient = {
  ...createNixClient({
    baseUrl: 'http://nix.invalid',
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
  }),
  query: (endpoint) => {
    if (endpoint.operation === 'pets.connection')
      return Promise.resolve(
        endpoint.schema.parse({
          provider: 'chatgpt',
          status: 'disconnected',
          reason: 'Connect ChatGPT to start a conversation.',
          canConnect: true,
        }),
      );
    if (endpoint.operation === 'pets.providers')
      return Promise.resolve(endpoint.schema.parse({ keys: [] }));
    return Promise.reject(new Error(`Unexpected settings story read: ${endpoint.operation}`));
  },
  execute: () => Promise.reject(new Error('This settings preview does not store credentials.')),
};

function settingsStory(provider: PetProfile['provider']): ReactElement {
  return (
    <ApiClientOverrideProvider client={settingsClient}>
      <PetSettingsEditor
        initial={{
          revision: 1,
          settings: {
            enabled: true,
            activePetId: '44444444-4444-4444-8444-444444444444',
            motion: 'reduced',
            profiles: [
              {
                id: '44444444-4444-4444-8444-444444444444',
                name: 'Pip',
                appearance: 'cat',
                personality: 'calm',
                responseLength: 'balanced',
                instructions: '',
                applyWithoutAsking: false,
                provider,
              },
            ],
            inlineWriting: false,
          },
        }}
        saving={false}
        onSave={() => Promise.resolve(true)}
      />
    </ApiClientOverrideProvider>
  );
}

export const Settings = {
  render: (): ReactElement => settingsStory('chatgpt'),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    canvas.getByRole('combobox', { name: 'Model provider' });
    await canvas.findByRole('button', { name: 'Connect ChatGPT' });
    canvas.getByRole('region', { name: 'ChatGPT connection' });
    if (canvas.queryByLabelText(/API key/) !== null)
      throw new Error('ChatGPT settings must not show API key controls.');
  },
};

function keySettingsPlay(label: string, otherLabel: string) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    canvas.getByRole('combobox', { name: 'Model provider' });
    const key = await canvas.findByLabelText(label);
    if (key.getAttribute('type') !== 'password')
      throw new Error('Provider API key fields must conceal their values.');
    if (
      canvas.queryByRole('region', { name: 'ChatGPT connection' }) !== null ||
      canvas.queryByLabelText(otherLabel) !== null
    )
      throw new Error('Only the selected provider may show its connection controls.');
  };
}

export const ClaudeSettings = {
  render: (): ReactElement => settingsStory('anthropic'),
  play: keySettingsPlay('Claude API key', 'OpenRouter API key'),
};
export const OpenRouterSettings = {
  render: (): ReactElement => settingsStory('openrouter'),
  play: keySettingsPlay('OpenRouter API key', 'Claude API key'),
};
export const DarkSettings = { ...Settings, globals: { ground: 'dark' } };
export const DarkClaudeSettings = { ...ClaudeSettings, globals: { ground: 'dark' } };
export const DarkOpenRouterSettings = { ...OpenRouterSettings, globals: { ground: 'dark' } };
export const DarkAnimationStates = { ...AnimationStates, globals: { ground: 'dark' } };

export const AnimatedCompanion = {
  args: { appearance: 'demiurge' as PetProfile['appearance'], state: 'idle' as PetAnimationState },
  argTypes: {
    appearance: { control: 'select', options: petCatalog.map((pet) => pet.appearance) },
    state: { control: 'select', options: petAnimationStates },
  },
  render: ({
    appearance,
    state,
  }: {
    appearance: PetProfile['appearance'];
    state: PetAnimationState;
  }): ReactElement => (
    <PetAvatar
      appearance={appearance}
      state={state}
      motion="full"
      label={`${appearance}: ${state}`}
    />
  ),
};

const previewClient = createNixClient({
  baseUrl: 'http://nix.invalid',
  tokens: {
    getAccessToken: () => Promise.resolve(null),
    refreshAccessToken: () => Promise.resolve(null),
  },
});
export const WorkApproval = {
  render: (): ReactElement => (
    <MemoryRouter>
      <PetWorkTools
        client={previewClient}
        workspaceId="11111111-1111-4111-8111-111111111111"
        petId="22222222-2222-4222-8222-222222222222"
        onChange={() => undefined}
        runtime={petConnectionSchema.parse({
          provider: 'chatgpt',
          status: 'connected',
          reason: '',
          canConnect: false,
          tools: [
            {
              id: 'preview',
              arguments: JSON.stringify({
                operation: 'create_note',
                itemId: '',
                parentId: '',
                title: 'Weekly plan',
                markdown: '# Weekly plan\n\n- Review priorities\n- Draft the release notes',
                query: '',
                propertiesJson: '',
              }),
              status: 'pending',
              result: '',
              claimId: '',
            },
          ],
        })}
      />
    </MemoryRouter>
  ),
};
export const DarkWorkApproval = { ...WorkApproval, globals: { ground: 'dark' } };

/** Two writes waiting at once: each card is named by its own change, and its buttons are
 * described by that name, so the owner can tell which one Approve request approves. */
export const TwoWritesWaiting = {
  render: (): ReactElement => {
    const note = (title: string) =>
      JSON.stringify({
        operation: 'create_note',
        itemId: '',
        parentId: '',
        title,
        markdown: '# Plan\n\n- Review priorities',
        query: '',
        propertiesJson: '',
      });
    return (
      <MemoryRouter>
        <PetWorkTools
          client={previewClient}
          workspaceId="11111111-1111-4111-8111-111111111111"
          petId="22222222-2222-4222-8222-222222222222"
          onChange={() => undefined}
          runtime={petConnectionSchema.parse({
            provider: 'chatgpt',
            status: 'connected',
            reason: '',
            canConnect: false,
            tools: [
              {
                id: 'waiting-a',
                arguments: note('Weekly plan'),
                status: 'pending',
                result: '',
                claimId: '',
              },
              {
                id: 'waiting-b',
                arguments: note('Monthly plan'),
                status: 'pending',
                result: '',
                claimId: '',
              },
            ],
          })}
        />
      </MemoryRouter>
    );
  },
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /Weekly plan/ }, { timeout: 10_000 });
    await canvas.findByRole('group', { name: /Monthly plan/ });
    if (canvas.getAllByRole('button', { name: 'Approve request' }).length !== 2)
      throw new Error('Each waiting card has its own Approve request.');
  },
};
export const DarkTwoWritesWaiting = { ...TwoWritesWaiting, globals: { ground: 'dark' } };

const appliedWorkspaceId = '11111111-1111-4111-8111-111111111111';
const appliedPetId = '22222222-2222-4222-8222-222222222222';
/** Two writes the owner's "Apply without asking" switch ran: one that finished, one that did
 * not. The receipts are what the real card stores (`writeActionReceipt`), so this renders the
 * same way a reopened panel does. */
export const AppliedWithoutAsking = {
  render: (): ReactElement => {
    writeActionReceipt(
      `tool:${appliedWorkspaceId}:${appliedPetId}:applied-done`,
      'Done without asking',
    );
    writeActionReceipt(
      `tool:${appliedWorkspaceId}:${appliedPetId}:applied-failed`,
      'Applying without asking…',
    );
    const note = (title: string) =>
      JSON.stringify({
        operation: 'create_note',
        itemId: '',
        parentId: '',
        title,
        markdown: '# Weekly plan\n\n- Review priorities\n- Draft the release notes',
        query: '',
        propertiesJson: '',
      });
    return (
      <MemoryRouter>
        <PetWorkTools
          client={previewClient}
          workspaceId={appliedWorkspaceId}
          petId={appliedPetId}
          onChange={() => undefined}
          applyWithoutAsking
          runtime={petConnectionSchema.parse({
            provider: 'chatgpt',
            status: 'connected',
            reason: '',
            canConnect: false,
            tools: [
              {
                id: 'applied-done',
                arguments: note('Weekly plan'),
                status: 'completed',
                result: '{"id":"33333333-3333-4333-8333-333333333333"}',
                claimId: 'c1',
              },
              {
                id: 'applied-failed',
                arguments: note('Release notes'),
                status: 'failed',
                result: 'The operation failed or its result is uncertain.',
                claimId: 'c2',
              },
            ],
          })}
        />
      </MemoryRouter>
    );
  },
};
export const DarkAppliedWithoutAsking = { ...AppliedWithoutAsking, globals: { ground: 'dark' } };

const structurePreviewModel: PreviewModel = {
  headline: 'I will create a Reading log with a board view.',
  destination: { title: 'Books', path: ['Books'] },
  counts: { items: 3, fields: 7, views: 2, entries: 0, writes: 12 },
  tree: [
    {
      label: 'Reading log',
      detail: ['Board view grouped by Status'],
      why: 'Keep the books you are reading together.',
      children: [
        {
          label: 'Fields',
          detail: [],
          children: [
            { label: 'Rating (number)', detail: [], children: [] },
            { label: 'Finished on (date)', detail: [], children: [] },
            { label: 'Status (select)', detail: [], children: [] },
          ],
        },
        { label: 'Board view', detail: ['Grouped by Status'], children: [] },
      ],
    },
  ],
  notes: [],
  warnings: [],
  problems: [],
  neverDoes: ['Publish a public link', 'Delete anything permanently', 'Remove or retype a field'],
};

export const StructureApproval = {
  render: (): ReactElement => <PetStructurePreview model={structurePreviewModel} />,
};
export const DarkStructureApproval = { ...StructureApproval, globals: { ground: 'dark' } };

const reviewWorkspaceId = '11111111-1111-4111-8111-111111111111';
const reviewItemId = '33333333-3333-4333-8333-333333333333';
const reviewProperties = [
  { key: 'status', label: 'Status', type: 'select', options: ['New', 'Done'], required: false },
  {
    key: 'category',
    label: 'Category',
    type: 'select',
    options: ['Work', 'Home'],
    required: false,
  },
];
const reviewView = {
  id: 'list',
  name: 'All work',
  kind: 'list',
  columns: ['title', 'status'],
  groupBy: 'status',
  groupOrder: ['New', 'Done'],
  dateProperty: null,
  endDateProperty: null,
  sortBy: null,
  sortDescending: false,
  mode: null,
  coverProperty: null,
  cardSize: null,
  layout: null,
  filters: [],
};
const reviewStoryClient = {
  query: (endpoint: { operation: string }): Promise<unknown> => {
    if (endpoint.operation === 'items.get')
      return Promise.resolve({
        id: reviewItemId,
        workspaceId: reviewWorkspaceId,
        parentId: null,
        title: 'Projects',
        type: 'note',
        properties: {},
      });
    if (endpoint.operation === 'schema.get')
      return Promise.resolve({
        properties: reviewProperties,
        declared: reviewProperties,
        inherit: true,
      });
    if (endpoint.operation === 'views.getConfigurations')
      return Promise.resolve({
        views: [reviewView],
        unrenderable: [],
        default: 'list',
        hideDocument: false,
        version: 'a'.repeat(64),
      });
    return Promise.reject(new Error(`Unexpected preview read: ${endpoint.operation}`));
  },
  execute: () => Promise.reject(new Error('This review story does not write.')),
  invalidate: () => undefined,
} as unknown as NixClient;

/** Changing an existing view always waits for a decision, including with the switch enabled. */
export const ViewUpdateApproval = {
  render: (): ReactElement => (
    <MemoryRouter>
      <PetWorkTools
        client={reviewStoryClient}
        workspaceId={reviewWorkspaceId}
        petId="22222222-2222-4222-8222-222222222222"
        onChange={() => undefined}
        applyWithoutAsking
        runtime={petConnectionSchema.parse({
          provider: 'chatgpt',
          status: 'connected',
          reason: '',
          canConnect: false,
          tools: [
            {
              id: 'view-update-review',
              arguments: JSON.stringify({
                operation: 'update_view',
                itemId: reviewItemId,
                parentId: '',
                title: '',
                markdown: '',
                query: '',
                propertiesJson: '',
                specJson: JSON.stringify({ viewId: 'list', patch: { groupBy: 'category' } }),
              }),
              status: 'pending',
              result: '',
              claimId: '',
            },
          ],
        })}
      />
    </MemoryRouter>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    await canvas.findByText('Before: Status (status)', {}, { timeout: 10_000 });
    await canvas.findByText('After: Category (category)');
    if (!canvas.getByRole('button', { name: 'Approve request' }).isConnected)
      throw new Error('A view change must wait for approval.');
    canvas.getByRole('group');
    if (canvas.queryByRole('region', { name: 'View id' }) !== null)
      throw new Error('A view selector is not text being changed.');
  },
};
export const DarkViewUpdateApproval = { ...ViewUpdateApproval, globals: { ground: 'dark' } };

/** A completed read stays a compact activity entry; partial evidence is visible in its details. */
export const ViewReadActivity = {
  render: (): ReactElement => (
    <MemoryRouter>
      <PetWorkTools
        client={reviewStoryClient}
        workspaceId={reviewWorkspaceId}
        petId="22222222-2222-4222-8222-222222222222"
        onChange={() => undefined}
        runtime={petConnectionSchema.parse({
          provider: 'chatgpt',
          status: 'connected',
          reason: '',
          canConnect: false,
          tools: [
            {
              id: 'view-read-review',
              arguments: JSON.stringify({
                operation: 'read_view',
                itemId: reviewItemId,
                parentId: '',
                title: '',
                markdown: '',
                query: JSON.stringify({ viewId: 'list', pageSize: 5 }),
                propertiesJson: '',
                specJson: '',
              }),
              status: 'completed',
              result:
                'Read All work in Projects. Returned 5 of 18 matching items. This sample does not reproduce temporary browser filters or personally hidden items.',
              claimId: 'read-claim',
            },
          ],
        })}
      />
    </MemoryRouter>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    await canvas.findByText('Read a view');
    canvas.getByText('Result details').click();
    canvas.getByText(/Returned 5 of 18 matching items/);
    canvas.getByText(/does not reproduce temporary browser filters or personally hidden items/);
    if (canvas.queryByRole('button', { name: 'Approve request' }) !== null)
      throw new Error('A completed read does not need an approval card.');
  },
};
export const DarkViewReadActivity = { ...ViewReadActivity, globals: { ground: 'dark' } };

const entriesPreviewModel: PreviewModel = {
  ...structurePreviewModel,
  headline: 'I will add 3 entries to Reading log.',
  counts: { items: 0, fields: 3, views: 0, entries: 3, writes: 3 },
  tree: [
    {
      label: 'Entries',
      detail: [],
      children: [
        { label: 'The Left Hand of Darkness', detail: ['Status: To read'], children: [] },
        { label: 'Kindred', detail: ['Status: Reading'], children: [] },
        { label: 'Piranesi', detail: ['Status: Finished'], children: [] },
      ],
    },
  ],
};
export const EntriesApproval = {
  render: (): ReactElement => <PetStructurePreview model={entriesPreviewModel} />,
};
export const DarkEntriesApproval = { ...EntriesApproval, globals: { ground: 'dark' } };

const formEditPreviewModel: PreviewModel = {
  ...structurePreviewModel,
  headline: 'I will update the interactive form on Reading log.',
  counts: { items: 0, fields: 1, views: 1, entries: 0, writes: 1 },
  tree: [
    {
      label: 'Page 1: Reading review',
      detail: [
        'Added field: Rating (number)',
        'Added question: Rating',
        'Removed question: Previous rating',
        'Reworded question: Review notes',
        'Now shown when Status equals Finished.',
      ],
      children: [],
    },
  ],
};
export const FormEditApproval = {
  render: (): ReactElement => <PetStructurePreview model={formEditPreviewModel} />,
};
export const DarkFormEditApproval = { ...FormEditApproval, globals: { ground: 'dark' } };

const problemsPreviewModel: PreviewModel = {
  ...structurePreviewModel,
  headline: 'I cannot run this request as written.',
  tree: [],
  problems: [
    {
      path: 'views[0].groupBy',
      code: 'unknown_field',
      message: 'Status is not in the current schema.',
    },
  ],
};
export const ProblemsApproval = {
  render: (): ReactElement => <PetStructurePreview model={problemsPreviewModel} />,
};
export const DarkProblemsApproval = { ...ProblemsApproval, globals: { ground: 'dark' } };

const structureWorkClient = {
  query: (endpoint: { operation: string }): Promise<unknown> => {
    if (endpoint.operation === 'items.get')
      return Promise.resolve({
        id: '33333333-3333-4333-8333-333333333333',
        workspaceId: '11111111-1111-4111-8111-111111111111',
        parentId: null,
        title: 'Reading log',
        properties: {},
      });
    if (endpoint.operation === 'schema.get')
      return Promise.resolve({ properties: [], declared: [], inherit: true });
    if (endpoint.operation === 'views.getConfigurations') return Promise.resolve({ views: [] });
    return Promise.reject(new Error(`Unexpected preview read: ${endpoint.operation}`));
  },
  invalidate: () => undefined,
} as unknown as NixClient;

export const StructureWorkApproval = {
  render: (): ReactElement => (
    <MemoryRouter>
      <PetWorkTools
        client={structureWorkClient}
        workspaceId="11111111-1111-4111-8111-111111111111"
        petId="22222222-2222-4222-8222-222222222222"
        onChange={() => undefined}
        runtime={petConnectionSchema.parse({
          provider: 'chatgpt',
          status: 'connected',
          reason: '',
          canConnect: false,
          tools: [
            {
              id: 'structure-preview',
              arguments: JSON.stringify({
                operation: 'add_fields',
                itemId: '33333333-3333-4333-8333-333333333333',
                parentId: '',
                title: '',
                markdown: '',
                query: '',
                propertiesJson: '',
                specJson: JSON.stringify({ fields: [{ label: 'Rating', type: 'number' }] }),
              }),
              status: 'pending',
              result: '',
              claimId: '',
            },
          ],
        })}
      />
    </MemoryRouter>
  ),
};

const BLUEPRINT_SOURCE_ID = '77777777-7777-4777-8777-777777777777';
const blueprintSource = {
  id: BLUEPRINT_SOURCE_ID,
  workspaceId: '11111111-1111-4111-8111-111111111111',
  parentId: null,
  title: 'Job hunt plan',
  type: 'note',
  hasChildren: false,
  seq: '1',
  lifecycleState: 'active',
  properties: {},
  createdAt: '2026-09-26T00:00:00Z',
  updatedAt: '2026-09-26T00:00:00Z',
};
const blueprintCardClient = {
  query: (endpoint: { operation: string }) =>
    endpoint.operation === 'items.get'
      ? Promise.resolve(blueprintSource)
      : Promise.reject(new Error(`Unexpected blueprint story query: ${endpoint.operation}`)),
  paginate: () => ({
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      yield* [];
    },
  }),
  execute: () => Promise.reject(new Error('Story approval is not interactive.')),
  invalidate: () => undefined,
} as unknown as NixClient;
const jobHuntBlueprint = {
  version: 1,
  title: 'Job hunt plan',
  summary: 'Track applications and follow-ups in one place.',
  root: {
    id: 'applications',
    title: 'Applications',
    fields: [{ label: 'Status', type: 'select', options: ['To apply', 'Interviewing', 'Closed'] }],
    views: [{ kind: 'board', groupBy: 'Status' }],
    children: [{ id: 'follow-up', title: 'Follow-up', sample: true }],
  },
  inputs: [{ key: 'contact_name', label: 'Contact name', type: 'text' }],
};

function blueprintToolStory(
  operation: 'build_blueprint' | 'save_as_template',
  status: 'pending' | 'completed' = 'pending',
  result = '',
): ReactElement {
  const args = {
    operation,
    itemId: operation === 'save_as_template' ? BLUEPRINT_SOURCE_ID : '',
    parentId: '',
    title: operation === 'save_as_template' ? 'Job hunt' : '',
    markdown: '',
    query: '',
    propertiesJson: '',
    specJson: JSON.stringify(
      operation === 'save_as_template' ? { inputs: jobHuntBlueprint.inputs } : jobHuntBlueprint,
    ),
  };
  return (
    <MemoryRouter>
      <PetWorkTools
        client={blueprintCardClient}
        workspaceId="11111111-1111-4111-8111-111111111111"
        petId="22222222-2222-4222-8222-222222222222"
        onChange={() => undefined}
        runtime={petConnectionSchema.parse({
          provider: 'chatgpt',
          status: 'connected',
          reason: '',
          canConnect: false,
          tools: [
            {
              id: `blueprint-${operation}`,
              arguments: JSON.stringify(args),
              status,
              result,
              claimId: '',
            },
          ],
        })}
      />
    </MemoryRouter>
  );
}

export const BlueprintApproval = {
  render: (): ReactElement => blueprintToolStory('build_blueprint'),
};
export const DarkBlueprintApproval = { ...BlueprintApproval, globals: { ground: 'dark' } };

export const IncompleteBuild = {
  render: (): ReactElement =>
    blueprintToolStory(
      'build_blueprint',
      'completed',
      JSON.stringify({
        rootId: BLUEPRINT_SOURCE_ID,
        complete: false,
        ledger: [
          {
            nodeId: 'applications',
            step: 'createStructuredItem',
            status: 'done',
            itemId: BLUEPRINT_SOURCE_ID,
          },
          { nodeId: 'follow-up', step: 'createItem', status: 'failed' },
        ],
      }),
    ),
};
export const DarkIncompleteBuild = { ...IncompleteBuild, globals: { ground: 'dark' } };

export const SaveTemplateApproval = {
  render: (): ReactElement => blueprintToolStory('save_as_template'),
};
export const DarkSaveTemplateApproval = { ...SaveTemplateApproval, globals: { ground: 'dark' } };

// Answers every history request with two archived conversations, so the story needs no server.
const historyClient = {
  execute: () =>
    Promise.resolve(
      petConnectionSchema.parse({
        provider: 'chatgpt',
        status: 'connected',
        reason: '',
        canConnect: false,
        history: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            title: 'Plan the release',
            createdAt: '2026-10-18T12:00:00Z',
          },
          {
            id: '44444444-4444-4444-8444-444444444444',
            title: 'Reading list',
            createdAt: '2026-10-12T12:00:00Z',
          },
        ],
        messages: [{ id: 'one', role: 'user', text: 'Keep this plan' }],
      }),
    ),
} as unknown as NixClient;

export const History = {
  render: (): ReactElement => (
    <PetHistory
      client={historyClient}
      workspaceId="11111111-1111-4111-8111-111111111111"
      petId="22222222-2222-4222-8222-222222222222"
      name="Pip"
    />
  ),
};

export const LongReply = {
  render: (): ReactElement => (
    <div className="flex h-128 w-128 max-w-full flex-col overflow-hidden rounded-lg border border-divider bg-background">
      <div className="shrink-0 border-b border-divider p-3">
        <Text variant="h3">Pip</Text>
      </div>
      <PetChatViewport latestKey="reply">
        <Text variant="note" tone="muted">
          You
        </Text>
        <Text>How should I organise the release notes?</Text>
        <div data-pet-latest-message="" className="flex shrink-0 flex-col gap-3">
          <Text variant="note" tone="muted">
            Pip
          </Text>
          {Array.from({ length: 6 }, (_, index) => (
            <Text key={index}>
              Keep the release overview short, then group the details by what changed for the
              reader. Put new features first, followed by improvements and fixes. Include links to
              the notes that explain each change.
            </Text>
          ))}
        </div>
      </PetChatViewport>
      <div className="shrink-0 border-t border-divider p-3">
        <Text variant="note">The message composer stays visible while reading.</Text>
      </div>
    </div>
  ),
};
export const DarkLongReply = { ...LongReply, globals: { ground: 'dark' } };

export const ResultLinks = {
  render: (): ReactElement => (
    <MemoryRouter>
      <PetMessageText
        workspaceId="11111111-1111-4111-8111-111111111111"
        text="Created [Release plan](/w/11111111-1111-4111-8111-111111111111?item=22222222-2222-4222-8222-222222222222). Review the draft before publishing."
      />
    </MemoryRouter>
  ),
};
export const DarkResultLinks = { ...ResultLinks, globals: { ground: 'dark' } };

export const MarkdownReply = {
  render: (): ReactElement => (
    <MemoryRouter>
      <div className="max-w-prose space-y-3 rounded-lg border border-divider bg-background p-3">
        <Text variant="note" tone="muted">
          Pip
        </Text>
        <PetMessageText
          workspaceId="11111111-1111-4111-8111-111111111111"
          text={
            'Nix supports these views:\n\n- **List** — rows, optionally grouped into sections\n- **Board** — cards grouped by a select field\n- **Calendar** — items arranged by date\n- **Checklist** — tickable items with progress\n\n### Next steps\n\n1. Open a container.\n2. Choose its view.\n\n> Workspace access is off, so I can’t check which views you already have configured.\n\nUse `view.kind` to describe a view.\n\n| View | Use |\n| --- | --- |\n| List | Rows |\n| Board | Cards |'
          }
        />
      </div>
    </MemoryRouter>
  ),
};
export const DarkMarkdownReply = { ...MarkdownReply, globals: { ground: 'dark' } };

const PHONE_WORKSPACE = '55555555-5555-4555-8555-555555555555';

const phoneWorkspace = {
  id: PHONE_WORKSPACE,
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

const phoneWorkspaceState = {
  status: 'ready',
  workspaces: [phoneWorkspace],
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

const phoneSettings = {
  revision: 1,
  settings: {
    enabled: true,
    activePetId: '44444444-4444-4444-8444-444444444444',
    motion: 'reduced' as const,
    profiles: [
      {
        id: '44444444-4444-4444-8444-444444444444',
        name: 'Pip',
        appearance: 'cat' as const,
        personality: 'calm' as const,
        responseLength: 'balanced' as const,
        instructions: '',
      },
    ],
  },
};

const phoneConnection = petConnectionSchema.parse({
  provider: 'chatgpt',
  status: 'connected',
  reason: 'Connected',
  canConnect: false,
  state: 'success',
  messages: [
    {
      id: 'question-1',
      role: 'user',
      text: 'Can you help me make a calm plan for the week?',
    },
    {
      id: 'answer-1',
      role: 'assistant',
      text: 'Of course. Start by choosing one thing that would make the week feel easier.\n\nOn Monday, take ten minutes to look at the commitments already in your calendar. Move anything that is not urgent, then choose one small task to finish before lunch. Keep the afternoon open for the work that needs your attention.\n\nOn Tuesday and Wednesday, leave a short break between meetings if you can. A little space makes it easier to recover when something takes longer than expected.\n\nAt the end of the week, notice what helped and carry only that forward. A plan should make room for the week you actually have, not add another standard to meet.',
    },
    {
      id: 'question-2',
      role: 'user',
      text: 'I have a busy Monday. What should I protect first?',
    },
    {
      id: 'reply',
      role: 'assistant',
      text: 'Protect a real lunch break and one focused block for your most important task. If the day fills up, those two anchors give you a place to begin and a chance to reset.\n\nYou could also leave a little space at the end of the day to write down what needs attention tomorrow. That way you do not have to keep the whole list in your head.',
    },
  ],
  verificationUrl: '',
  userCode: '',
});

/** Must-fix 9: the companion's connection now streams through the watch loop
 * (`client.query(pets.watchRuntime(...))`), not the old `execute`-only read - so a stub whose
 * `query` always answered with the settings payload made every conversation story's watch fail
 * schema validation and fall back to the connection panel instead of its own named state. Routing
 * by `endpoint.operation` is what lets the same stub answer both `pets.settings` (settings sheet)
 * and `pets.watchRuntime` (the live conversation) correctly. `revision: 1` keeps every watch tick
 * after the first a no-op rather than replaying `applyIfNewer`'s "equal revision" branch forever. */
function routeQuery(
  settings: unknown,
  connection: ReturnType<typeof petConnectionSchema.parse>,
): (endpoint: { operation: string }) => Promise<unknown> {
  return (endpoint) =>
    endpoint.operation === 'items.get'
      ? Promise.resolve({
          id: '66666666-6666-4666-8666-666666666666',
          workspaceId: PHONE_WORKSPACE,
          title: 'Nix documentation',
          type: 'note',
        })
      : endpoint.operation === 'locks.get'
        ? Promise.resolve({ locked: false, unlockedUntil: null })
        : endpoint.operation === 'pets.watchRuntime' || endpoint.operation === 'pets.connection'
          ? Promise.resolve({ ...connection, revision: 1 })
          : Promise.resolve(settings);
}

const phoneClient = {
  ...createNixClient({
    baseUrl: 'http://nix.invalid',
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
  }),
  query: routeQuery(phoneSettings, phoneConnection),
  execute: () => Promise.resolve(phoneConnection),
} as NixClient;

/**
 * Stubs `matchMedia` to answer narrow (below the 640px phone breakpoint) so the two stories
 * below render their phone layout, and restores the previous implementation when the story
 * unmounts rather than leaking it into whichever story renders next.
 */
function stubNarrowMatchMedia(): () => void {
  const original = window.matchMedia.bind(window);
  window.matchMedia = (query: string) =>
    ({
      matches: !query.includes('640'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
  return () => {
    window.matchMedia = original;
  };
}

function stubPhoneSurface(): () => void {
  const previous = window.localStorage.getItem('nix.pet.surface');
  window.localStorage.setItem('nix.pet.surface', 'page-on-phones');
  return () => {
    if (previous === null) window.localStorage.removeItem('nix.pet.surface');
    else window.localStorage.setItem('nix.pet.surface', previous);
  };
}

/**
 * A device-sized frame for the phone stories below. `transform` on this box gives every
 * `position: fixed` descendant it, rather than the Storybook canvas, as its containing block
 * (CSS Transforms), which is what keeps the companion's fixed launcher and full-screen dialog
 * inside the simulated device rather than pinned to the whole preview iframe. `matchMedia` is
 * stubbed narrow synchronously, during this render, guarded by a ref so it runs once - so the
 * companion tree's own first render already sees the phone layout rather than painting wide and
 * then jumping.
 */
function PhoneFrame({
  children,
  initialEntry = `/w/${PHONE_WORKSPACE}`,
  width = 390,
  height = 844,
}: {
  readonly children: ReactNode;
  readonly initialEntry?: string;
  readonly width?: number;
  readonly height?: number;
}): ReactElement {
  const restore = useRef<(() => void) | null>(null);
  restore.current ??= (() => {
    const restoreMedia = stubNarrowMatchMedia();
    const restoreSurface = stubPhoneSurface();
    return () => {
      restoreMedia();
      restoreSurface();
    };
  })();
  useEffect(
    () => () => {
      restore.current?.();
      restore.current = null;
    },
    [],
  );
  return (
    <div
      style={{ width, height, transform: 'translateZ(0)' }} // design-token-exempt: simulates a fixed device viewport for a story.
      className="relative flex h-full max-h-[calc(100dvh-var(--spacing)*8)] min-h-0 max-w-full flex-col overflow-hidden rounded-lg border border-divider"
    >
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/w/:workspaceId"
            element={
              <ApiClientOverrideProvider client={phoneClient}>
                <WorkspaceProvider state={phoneWorkspaceState}>{children}</WorkspaceProvider>
              </ApiClientOverrideProvider>
            }
          />
          <Route
            path="/w/:workspaceId/pet"
            element={
              <ApiClientOverrideProvider client={phoneClient}>
                <WorkspaceProvider state={phoneWorkspaceState}>
                  <PetPage />
                </WorkspaceProvider>
              </ApiClientOverrideProvider>
            }
          />
        </Routes>
      </MemoryRouter>
    </div>
  );
}

export const CompanionPhone = {
  render: (): ReactElement => (
    <PhoneFrame>
      <PetCompanion />
    </PhoneFrame>
  ),
};
export const DarkCompanionPhone = { ...CompanionPhone, globals: { ground: 'dark' } };

/**
 * Follows the phone's default page preference with a native click (no test-only dependency), so
 * the conversation stories exercise the same launcher-to-page route a reader uses. The launcher
 * only exists once settings have resolved, so a `MutationObserver` waits rather than clicking on
 * the empty first render. The Talk label remains supported for a story where floating is chosen.
 */
function AutoOpenCompanion(): ReactElement {
  const container = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const clickWhenReady = (): boolean => {
      const button = node.querySelector<HTMLButtonElement>(
        'button[aria-label^="Open "], button[aria-label^="Talk with "]',
      );
      if (!button) return false;
      button.click();
      return true;
    };
    if (clickWhenReady()) return;
    const observer = new MutationObserver(() => {
      if (clickWhenReady()) observer.disconnect();
    });
    observer.observe(node, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  }, []);
  return (
    <div ref={container}>
      <PetCompanion />
    </div>
  );
}

export const ConversationPhone = {
  render: (): ReactElement => (
    <PhoneFrame>
      <AutoOpenCompanion />
    </PhoneFrame>
  ),
};
export const NoteConversationPhone280 = {
  render: (): ReactElement => (
    <PhoneFrame
      width={280}
      initialEntry={`/w/${PHONE_WORKSPACE}/pet?root=66666666-6666-4666-8666-666666666666`}
    >
      <PetPage />
    </PhoneFrame>
  ),
};
export const DarkNoteConversationPhone280 = {
  ...NoteConversationPhone280,
  globals: { ground: 'dark' },
};

export const DarkConversationPhone = { ...ConversationPhone, globals: { ground: 'dark' } };

export const ConversationPhone320 = {
  render: (): ReactElement => (
    <PhoneFrame width={320}>
      <AutoOpenCompanion />
    </PhoneFrame>
  ),
};
export const DarkConversationPhone320 = {
  ...ConversationPhone320,
  globals: { ground: 'dark' },
};

export const ConversationPhone280 = {
  render: (): ReactElement => (
    <PhoneFrame width={280}>
      <AutoOpenCompanion />
    </PhoneFrame>
  ),
};
export const DarkConversationPhone280 = {
  ...ConversationPhone280,
  globals: { ground: 'dark' },
};

export const ConversationPhoneLandscape = {
  render: (): ReactElement => (
    <PhoneFrame width={568} height={320}>
      <AutoOpenCompanion />
    </PhoneFrame>
  ),
};
export const DarkConversationPhoneLandscape = {
  ...ConversationPhoneLandscape,
  globals: { ground: 'dark' },
};

/** A desktop-width companion, wired the same way `PhoneFrame` is but without the narrow stub, so
 * the redesigned dialog (header row, settings sheet, activity rows) can be shown at its normal
 * floating-panel size. `connection` stands in for every `pets.runtime` call the open dialog
 * makes, which is enough for a static story - nothing here submits a new one. */
function desktopClient(connection: ReturnType<typeof petConnectionSchema.parse>): NixClient {
  return {
    ...createNixClient({
      baseUrl: 'http://nix.invalid',
      tokens: {
        getAccessToken: () => Promise.resolve(null),
        refreshAccessToken: () => Promise.resolve(null),
      },
    }),
    query: routeQuery(
      {
        ...phoneSettings,
        settings: {
          ...phoneSettings.settings,
          profiles: phoneSettings.settings.profiles.map((profile) => ({
            ...profile,
            provider: connection.provider,
          })),
        },
      },
      connection,
    ),
    execute: () => Promise.resolve(connection),
  } as NixClient;
}

function DesktopFrame({
  connection,
  children,
}: {
  readonly connection: ReturnType<typeof petConnectionSchema.parse>;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="relative h-[42rem] w-full">
      <MemoryRouter initialEntries={[`/w/${PHONE_WORKSPACE}`]}>
        <Routes>
          <Route
            path="/w/:workspaceId"
            element={
              <ApiClientOverrideProvider client={desktopClient(connection)}>
                <WorkspaceProvider state={phoneWorkspaceState}>{children}</WorkspaceProvider>
              </ApiClientOverrideProvider>
            }
          />
        </Routes>
      </MemoryRouter>
    </div>
  );
}

/** Clicks the first element under `node` that `match` accepts, once it appears - the same
 * MutationObserver-driven pattern `AutoOpenCompanion` above uses, generalised to walk further
 * into the dialog (open it, then its overflow menu, then one of the menu's items) since a story
 * has no test runner to drive those clicks for it. */
function AutoOpenPanel({
  menuItemLabel,
  children,
}: {
  readonly menuItemLabel: string;
  readonly children: ReactNode;
}): ReactElement {
  const container = useRef<HTMLDivElement | null>(null);
  const stage = useRef<'launcher' | 'menu' | 'item' | 'done'>('launcher');
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    // Menus are portaled outside their pane; the isolated story document owns those controls.
    const surface = node.ownerDocument.body;
    const click = (match: (el: HTMLElement) => boolean): boolean => {
      const found = Array.from(
        surface.querySelectorAll<HTMLElement>('button, [role="menuitem"]'),
      ).find(match);
      if (!found) return false;
      found.click();
      return true;
    };
    const advance = (): void => {
      if (
        stage.current === 'launcher' &&
        click((el) => (el.getAttribute('aria-label') ?? '').startsWith('Talk with '))
      )
        stage.current = 'menu';
      if (
        stage.current === 'menu' &&
        click((el) => el.getAttribute('aria-label') === 'More conversation actions')
      )
        stage.current = 'item';
      if (stage.current === 'item' && click((el) => el.textContent.trim() === menuItemLabel))
        stage.current = 'done';
    };
    advance();
    const observer = new MutationObserver(() => {
      advance();
      if (stage.current === 'done') observer.disconnect();
    });
    observer.observe(surface, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  }, [menuItemLabel]);
  return <div ref={container}>{children}</div>;
}

const emptyChatConnection = petConnectionSchema.parse({
  provider: 'chatgpt',
  status: 'connected',
  reason: 'Connected',
  canConnect: false,
  messages: [],
});

export const QuietLauncher = {
  render: (): ReactElement => (
    <DesktopFrame connection={emptyChatConnection}>
      <PetCompanion />
    </DesktopFrame>
  ),
};
export const DarkQuietLauncher = { ...QuietLauncher, globals: { ground: 'dark' } };

export const EmptyChat = {
  render: (): ReactElement => (
    <DesktopFrame connection={emptyChatConnection}>
      <AutoOpenCompanion />
    </DesktopFrame>
  ),
};
export const DarkEmptyChat = { ...EmptyChat, globals: { ground: 'dark' } };

/** The one-row header and one-row composer: the controls a reader needs, each named. */
async function expectChatControls({
  canvasElement,
}: {
  canvasElement: HTMLElement;
}): Promise<void> {
  const canvas = within(canvasElement);
  await canvas.findByRole('button', { name: 'More conversation actions' }, { timeout: 10_000 });
  await canvas.findByRole('button', { name: 'Add to message' });
  await canvas.findByRole('textbox', { name: /^Message / });
  canvas.getByRole('button', { name: 'Send' });
}
export const ConversationControlsDesktop = {
  render: (): ReactElement => (
    <DesktopFrame connection={emptyChatConnection}>
      <AutoOpenCompanion />
    </DesktopFrame>
  ),
  play: expectChatControls,
};
export const ConversationControlsPhone = {
  render: (): ReactElement => (
    <PhoneFrame width={320}>
      <AutoOpenCompanion />
    </PhoneFrame>
  ),
  play: expectChatControls,
};

const markdownConversationConnection = petConnectionSchema.parse({
  provider: 'chatgpt',
  status: 'connected',
  reason: 'Connected',
  canConnect: false,
  state: 'success',
  messages: [
    { id: 'markdown-question', role: 'user', text: 'Which views should I use?' },
    {
      id: 'markdown-answer',
      role: 'assistant',
      text: '### Next steps\n\n1. Open a container.\n2. Choose its view.\n\n##### Review options\n\nUse **List** for rows or **Board** for cards.\n\n#### Check limits\n\nWorkspace access is off, so I can’t check your configured views.\n\n## Keep changes in review\n\nThe approval card shows each change before it runs.',
    },
  ],
});

/** Source headings are normalized beneath the actual conversation h2, including skipped depths. */
export const MarkdownConversation = {
  render: (): ReactElement => (
    <DesktopFrame connection={markdownConversationConnection}>
      <AutoOpenCompanion />
    </DesktopFrame>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: 'Pip', level: 2 }, { timeout: 10_000 });
    await canvas.findByRole('heading', { name: 'Next steps', level: 3 });
    canvas.getByRole('heading', { name: 'Review options', level: 4 });
    canvas.getByRole('heading', { name: 'Check limits', level: 4 });
    canvas.getByRole('heading', { name: 'Keep changes in review', level: 3 });
  },
};
export const DarkMarkdownConversation = { ...MarkdownConversation, globals: { ground: 'dark' } };

const STREAM_TOOL_ID = '66666666-6666-4666-8666-666666666666';
const streamedTurnConnection = petConnectionSchema.parse({
  provider: 'chatgpt',
  status: 'connected',
  reason: 'Connected',
  canConnect: false,
  state: 'thinking',
  messages: [
    {
      id: 'user-1',
      role: 'user',
      text: 'Find my reading notes and set up a tracker.',
    },
    {
      id: 'user-1:commentary:1',
      role: 'assistant',
      text: 'Let me look at what you already have first.',
    },
  ],
  tools: [
    {
      id: 'read-1',
      arguments: JSON.stringify({
        operation: 'search',
        query: 'reading',
        itemId: '',
        parentId: '',
        title: '',
        markdown: '',
        propertiesJson: '',
      }),
      status: 'completed',
      result: 'Found 3 items.',
      claimId: 'claim-1',
    },
    {
      id: STREAM_TOOL_ID,
      arguments: JSON.stringify({
        operation: 'create_structured',
        title: 'Reading log',
        itemId: '',
        parentId: '',
        markdown: '',
        query: '',
        propertiesJson: '',
        specJson: JSON.stringify({
          recipe: 'board',
          fields: [{ label: 'Status', type: 'select', options: ['To read', 'Reading', 'Done'] }],
          views: [{ kind: 'board', groupBy: 'Status' }],
          inherit: true,
        }),
      }),
      status: 'pending',
      result: '',
      claimId: '',
    },
  ],
});

export const StreamedTurn = {
  render: (): ReactElement => (
    <DesktopFrame connection={streamedTurnConnection}>
      <AutoOpenCompanion />
    </DesktopFrame>
  ),
};
export const DarkStreamedTurn = { ...StreamedTurn, globals: { ground: 'dark' } };

const STREAMING_DRAFT_ID = 'streaming-user-1:draft:aaaaaaaaaaaaaaaa';
const streamingReplyConnection = petConnectionSchema.parse({
  provider: 'chatgpt',
  status: 'connected',
  reason: 'Connected',
  canConnect: false,
  state: 'thinking',
  messages: [
    { id: 'streaming-user-1', role: 'user', text: 'Draft a weekly plan outline.' },
    {
      id: STREAMING_DRAFT_ID,
      role: 'assistant',
      text: 'Here is a draft outline: Monday - review priorities, Tuesday - ',
    },
  ],
});

/** A still-streaming reply shows the motion-safe caret and a "Writing" status. */
export const StreamingReply = {
  render: (): ReactElement => (
    <DesktopFrame connection={streamingReplyConnection}>
      <AutoOpenCompanion />
    </DesktopFrame>
  ),
};
export const DarkStreamingReply = { ...StreamingReply, globals: { ground: 'dark' } };

const turnErrorConnection = petConnectionSchema.parse({
  provider: 'chatgpt',
  status: 'connected',
  reason: 'The response did not finish. Try again.',
  canConnect: false,
  state: 'error',
  messages: [{ id: 'user-1', role: 'user', text: 'Summarize my reading notes.' }],
});

/** A failed turn: the error sits after the last message with its retry, not above the log. */
export const ConversationTurnError = {
  render: (): ReactElement => (
    <DesktopFrame connection={turnErrorConnection}>
      <AutoOpenCompanion />
    </DesktopFrame>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    await canvas.findByRole('button', { name: 'Try again' }, { timeout: 10_000 });
  },
};
export const DarkConversationTurnError = { ...ConversationTurnError, globals: { ground: 'dark' } };

const launcherBadgeConnection = petConnectionSchema.parse({
  provider: 'chatgpt',
  status: 'connected',
  reason: 'Connected',
  canConnect: false,
  messages: [{ id: 'badge-user-1', role: 'user', text: 'Create a note called Weekly plan.' }],
  tools: [
    {
      id: 'badge-tool-1',
      arguments: JSON.stringify({
        operation: 'create_note',
        title: 'Weekly plan',
        markdown: '# Weekly plan',
        itemId: '',
        parentId: '',
        query: '',
        propertiesJson: '',
      }),
      status: 'pending',
      result: '',
      claimId: '',
    },
  ],
});

/** The panel stays closed (no `AutoOpenCompanion`): the launcher shows the token-backed dot
 * badge for the pending tool, and its accessible name gains "(needs approval)". */
export const LauncherBadge = {
  render: (): ReactElement => (
    <DesktopFrame connection={launcherBadgeConnection}>
      <PetCompanion />
    </DesktopFrame>
  ),
};
export const DarkLauncherBadge = { ...LauncherBadge, globals: { ground: 'dark' } };

const autoDeclinedConnection = petConnectionSchema.parse({
  provider: 'chatgpt',
  status: 'connected',
  reason: 'Connected',
  canConnect: false,
  messages: [
    {
      id: 'user-2',
      role: 'user',
      text: 'Add a Status field with a made-up view kind.',
    },
  ],
  tools: [
    {
      id: 'declined-1',
      arguments: JSON.stringify({
        operation: 'create_structured',
        title: 'Board',
        itemId: '',
        parentId: '',
        markdown: '',
        query: '',
        propertiesJson: '',
        specJson: JSON.stringify({ recipe: 'drive', fields: [], inherit: true }),
      }),
      status: 'failed',
      result:
        'Declined: the design has problems.\nviews[0].kind: "drive" is not a supported view kind.',
      claimId: 'claim-2',
    },
  ],
});

export const AutoDeclinedWrite = {
  render: (): ReactElement => (
    <DesktopFrame connection={autoDeclinedConnection}>
      <AutoOpenCompanion />
    </DesktopFrame>
  ),
};
export const DarkAutoDeclinedWrite = { ...AutoDeclinedWrite, globals: { ground: 'dark' } };

const completedReceiptConnection = petConnectionSchema.parse({
  provider: 'chatgpt',
  status: 'connected',
  reason: 'Connected',
  canConnect: false,
  state: 'success',
  messages: [
    { id: 'user-3', role: 'user', text: 'Create a note called Weekly plan.' },
    { id: 'assistant-3', role: 'assistant', text: 'Done - Weekly plan is ready.' },
  ],
  tools: [
    {
      id: 'completed-1',
      arguments: JSON.stringify({
        operation: 'create_note',
        title: 'Weekly plan',
        markdown: '# Weekly plan',
        itemId: '',
        parentId: '',
        query: '',
        propertiesJson: '',
      }),
      status: 'completed',
      result: 'Created "Weekly plan".',
      claimId: 'claim-3',
    },
  ],
});

/** The receipt this shows ("Approved - done") comes from a per-tab session receipt, not from
 * the connection snapshot alone - see `action-receipts.ts` - so the story seeds it the same way
 * a completed approval leaves it, rather than only through the tool's own `status`. */
export const CompletedReceipt = {
  render: (): ReactElement => {
    try {
      sessionStorage.setItem(
        `nix.pet.action.tool:${PHONE_WORKSPACE}:44444444-4444-4444-8444-444444444444:completed-1`,
        'Completed.',
      );
    } catch {
      /* Session storage may be unavailable in this preview. */
    }
    return (
      <DesktopFrame connection={completedReceiptConnection}>
        <AutoOpenCompanion />
      </DesktopFrame>
    );
  },
};
export const DarkCompletedReceipt = { ...CompletedReceipt, globals: { ground: 'dark' } };

const disconnectedConnection = petConnectionSchema.parse({
  provider: 'chatgpt',
  status: 'disconnected',
  reason: 'Connect ChatGPT to start a conversation.',
  canConnect: true,
});

export const Disconnected = {
  render: (): ReactElement => (
    <DesktopFrame connection={disconnectedConnection}>
      <AutoOpenCompanion />
    </DesktopFrame>
  ),
};
export const DarkDisconnected = { ...Disconnected, globals: { ground: 'dark' } };

function keyDisconnectedPlay(reason: string) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    const alert = await canvas.findByRole('alert');
    if (alert.textContent !== reason)
      throw new Error('A disconnected pet must explain how to set up its selected provider.');
    const settings = canvas.getByRole('link', { name: 'Open Pet settings' });
    if (settings.getAttribute('href') !== `/w/${PHONE_WORKSPACE}/settings?tab=pets`)
      throw new Error('Provider setup must open settings in the current workspace.');
    if (
      canvas.queryByRole('button', { name: 'Connect ChatGPT' }) !== null ||
      canvas.queryByRole('link', { name: 'Open ChatGPT sign-in' }) !== null
    )
      throw new Error('API key providers must not ask for ChatGPT sign-in.');
  };
}

export const ClaudeDisconnected = {
  render: (): ReactElement => (
    <DesktopFrame
      connection={petConnectionSchema.parse({
        provider: 'anthropic',
        status: 'disconnected',
        reason: 'Add a Claude API key in Pet settings.',
        canConnect: false,
      })}
    >
      <AutoOpenCompanion />
    </DesktopFrame>
  ),
  play: keyDisconnectedPlay('Add a Claude API key in Pet settings.'),
};
export const OpenRouterDisconnected = {
  render: (): ReactElement => (
    <DesktopFrame
      connection={petConnectionSchema.parse({
        provider: 'openrouter',
        status: 'disconnected',
        reason: 'Add an OpenRouter API key in Pet settings.',
        canConnect: false,
      })}
    >
      <AutoOpenCompanion />
    </DesktopFrame>
  ),
  play: keyDisconnectedPlay('Add an OpenRouter API key in Pet settings.'),
};
export const DarkClaudeDisconnected = { ...ClaudeDisconnected, globals: { ground: 'dark' } };
export const DarkOpenRouterDisconnected = {
  ...OpenRouterDisconnected,
  globals: { ground: 'dark' },
};

export const SettingsSheet = {
  render: (): ReactElement => (
    <DesktopFrame connection={emptyChatConnection}>
      <AutoOpenPanel menuItemLabel="Chat settings">
        <PetCompanion />
      </AutoOpenPanel>
    </DesktopFrame>
  ),
};
export const DarkSettingsSheet = { ...SettingsSheet, globals: { ground: 'dark' } };

export const HistoryPanel = {
  render: (): ReactElement => (
    <DesktopFrame connection={emptyChatConnection}>
      <AutoOpenPanel menuItemLabel="Past conversations">
        <PetCompanion />
      </AutoOpenPanel>
    </DesktopFrame>
  ),
};
export const DarkHistoryPanel = { ...HistoryPanel, globals: { ground: 'dark' } };

const bodyEditNoteId = '33333333-3333-4333-8333-333333333333';
const bodyEditWorkspaceId = '11111111-1111-4111-8111-111111111111';
const bodyEditPetId = '22222222-2222-4222-8222-222222222222';

type BodyEditRuntime = ReturnType<typeof petConnectionSchema.parse>;

/** A note's whole collab history as one update, served the way the collab endpoint pages it, so
 * the card computes its before and after text from a real document. Writes are accepted, and a
 * runtime call moves the tool on (claimed, then completed) the way the worker does, so a story
 * can show what the switch leaves behind. */
function bodyEditClient(
  content: string | { type: 'doc'; content: unknown[] },
  onRuntime?: (operation: string, requestId: string) => BodyEditRuntime,
): NixClient {
  const parsed = typeof content === 'string' ? markdownToDocument(content) : undefined;
  const doc = new Y.Doc();
  const json = parsed === undefined ? content : parsed.ok ? parsed.doc : undefined;
  if (json !== undefined)
    prosemirrorJSONToYXmlFragment(nixSchema, json, doc.getXmlFragment('default'));
  const update = btoa(
    Array.from(Y.encodeStateAsUpdate(doc), (byte) => String.fromCharCode(byte)).join(''),
  );
  doc.destroy();
  return {
    query: (endpoint: { operation: string }): Promise<unknown> => {
      if (endpoint.operation === 'companion.body.read')
        return Promise.resolve({ hasMore: false, updates: [{ seq: '1', update }] });
      if (endpoint.operation === 'items.get')
        return Promise.resolve({
          id: bodyEditNoteId,
          workspaceId: bodyEditWorkspaceId,
          parentId: null,
          title: 'Trip plan',
          type: 'note',
          properties: {},
        });
      return Promise.reject(new Error(`Unexpected preview read: ${endpoint.operation}`));
    },
    execute: (endpoint: {
      operation: string;
      body?: { operation?: string; requestId?: string };
    }): Promise<unknown> => {
      if (endpoint.operation === 'companion.body.append') return Promise.resolve({ seq: '2' });
      if (onRuntime && endpoint.body?.operation)
        return Promise.resolve(onRuntime(endpoint.body.operation, endpoint.body.requestId ?? ''));
      return Promise.reject(new Error('This story does not write.'));
    },
    invalidate: () => undefined,
  } as unknown as NixClient;
}

const bodyEditNote = [
  '# Trip plan',
  '',
  '## Packing',
  '',
  '- Passport',
  '- Clothes',
  '  - Socks',
  '  - Shirts',
  '',
  '```sh',
  'pack --all',
  '```',
  '',
  '## Budget',
  '',
  'Total is 400.',
].join('\n');

function bodyEditRuntime(
  operation: 'replace_section' | 'replace_passage',
  query: string,
  markdown: string,
): BodyEditRuntime {
  return petConnectionSchema.parse({
    provider: 'chatgpt',
    status: 'connected',
    reason: '',
    canConnect: false,
    tools: [
      {
        id: `preview-${operation}`,
        arguments: JSON.stringify({
          operation,
          itemId: bodyEditNoteId,
          parentId: '',
          title: '',
          markdown,
          query,
          propertiesJson: '',
          specJson: '',
        }),
        status: 'pending',
        result: '',
        claimId: '',
      },
    ],
  });
}

function BodyEditCard({
  operation,
  query,
  markdown,
  content = bodyEditNote,
  applyWithoutAsking = false,
}: {
  readonly operation: 'replace_section' | 'replace_passage';
  readonly query: string;
  readonly markdown: string;
  readonly content?: string | { type: 'doc'; content: unknown[] };
  readonly applyWithoutAsking?: boolean;
}): ReactElement {
  return (
    <MemoryRouter>
      <PetWorkTools
        client={bodyEditClient(content)}
        workspaceId={bodyEditWorkspaceId}
        petId={bodyEditPetId}
        onChange={() => undefined}
        applyWithoutAsking={applyWithoutAsking}
        runtime={bodyEditRuntime(operation, query, markdown)}
      />
    </MemoryRouter>
  );
}

/** A section edit: nested list and code block out, a shorter list in, heading kept. The
 * changed lines are marked on both sides. */
export const SectionEditApproval = {
  render: (): ReactElement => (
    <BodyEditCard
      operation="replace_section"
      query="Packing"
      markdown={'- Passport\n- Tickets\n- Charger'}
    />
  ),
};
export const DarkSectionEditApproval = { ...SectionEditApproval, globals: { ground: 'dark' } };

/** A passage edit inside one nested list item: only the changed characters are marked. */
export const PassageEditApproval = {
  render: (): ReactElement => (
    <BodyEditCard operation="replace_passage" query="Shirts" markdown="T-shirts" />
  ),
};
export const DarkPassageEditApproval = { ...PassageEditApproval, globals: { ground: 'dark' } };

/** A coloured paragraph removed through the real card, with the switch on: the loss is a
 * warning in words, nothing replaces the text, and the card says why it waits anyway. */
export const PassageRemovalWithLoss = {
  render: (): ReactElement => (
    <BodyEditCard
      operation="replace_passage"
      query="then confirm the caterer."
      markdown=""
      applyWithoutAsking
      content={{
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Book the venue by Friday, ' },
              {
                type: 'text',
                text: 'then confirm the caterer.',
                marks: [{ type: 'textColor', attrs: { text: 'accent', background: null } }],
              },
            ],
          },
          { type: 'paragraph', content: [{ type: 'text', text: 'Send the invitations.' }] },
        ],
      }}
    />
  ),
};
export const DarkPassageRemovalWithLoss = {
  ...PassageRemovalWithLoss,
  globals: { ground: 'dark' },
};

/** A clean passage edit the "Apply without asking" switch ran: the receipt says so, and "What
 * was applied" keeps the before and after text and the way back through the note's history. */
function AppliedBodyEditReceipt(): ReactElement {
  const initial = bodyEditRuntime('replace_passage', 'Shirts', 'T-shirts');
  const [live, setLive] = useState(initial);
  const [client] = useState(() =>
    bodyEditClient(bodyEditNote, (operation, requestId) => ({
      ...initial,
      tools: (initial.tools ?? []).map((tool) => ({
        ...tool,
        status: operation === 'tool_result' ? 'completed' : 'claimed',
        claimId: requestId,
        result: operation === 'tool_result' ? '{"replaced":true}' : '',
      })),
    })),
  );
  return (
    <MemoryRouter>
      <PetWorkTools
        client={client}
        workspaceId={bodyEditWorkspaceId}
        petId={bodyEditPetId}
        onChange={setLive}
        applyWithoutAsking
        runtime={live}
      />
    </MemoryRouter>
  );
}
export const AppliedBodyEditWithoutAsking = {
  render: (): ReactElement => <AppliedBodyEditReceipt />,
};
export const DarkAppliedBodyEditWithoutAsking = {
  ...AppliedBodyEditWithoutAsking,
  globals: { ground: 'dark' },
};
