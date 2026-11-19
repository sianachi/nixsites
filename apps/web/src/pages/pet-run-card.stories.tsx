import { createNixClient, type PetRunResponse } from '@nix/api-client';
import { within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { AuthOverrideProvider } from '@nix/web-platform/auth/auth-provider';
import type { ReactNode } from 'react';
import { PetCanvasReviewLayout, PetCanvasReviewPane } from '../panel/pet-canvas-review';
import { PetRunCard } from '../panel/pet-run-card';

export default { title: 'Nix/Companion/Pet jobs' };

const client = createNixClient({
  baseUrl: 'http://nix.invalid',
  tokens: {
    getAccessToken: () => Promise.resolve(null),
    refreshAccessToken: () => Promise.resolve(null),
  },
});

const run: PetRunResponse = {
  id: '49b80577-9ad4-46aa-ad2c-5988fda36abf',
  itemId: '4dffbc88-ea17-4299-96dc-8bac562dd9d0',
  workspaceId: '8d849a57-bd08-487d-af5b-e0f69ac836a4',
  brief: 'Review the design notes and write a short comment for the team.',
  sourceItemIds: [],
  abilities: ['comment.create'],
  workspaceScope: false,
  status: 'waiting_for_approval',
  revision: 3,
  question: null,
  proposals: [
    {
      id: '8eadd6a1-e91a-4be5-b3c4-a37d341b6d51',
      capability: 'comment.create',
      description: 'Post a comment on Design review',
      preview: { text: 'The revised flow is ready for review.' },
      status: 'pending',
    },
  ],
  results: [],
  createdAt: '2026-11-17T12:00:00Z',
  updatedAt: '2026-11-17T12:00:00Z',
};

export const WaitingForApproval = {
  render: (): ReactNode => (
    <div className="w-full max-w-xs p-3">
      <PetRunCard client={client} run={run} onUpdate={() => undefined} />
    </div>
  ),
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    await canvas.findByRole('button', { name: 'Post comment' });
    await canvas.findByText(/The revised flow is ready for review/u);
  },
};

const outdatedShape = { id: 'outdated', type: 'rectangle', version: 1, versionNonce: 1 };

export const DrawingNeedsRefresh = {
  render: (): ReactNode => (
    <AuthOverrideProvider
      value={{
        mode: 'local',
        setupRequired: false,
        isConfigured: true,
        accountUrl: null,
        signIn: () => Promise.resolve(),
        signOut: () => Promise.resolve(),
        getAccessToken: () => Promise.resolve(null),
        handleSessionRefusal: () => undefined,
      }}
    >
      <PetCanvasReviewLayout>
        {() => (
          <div className="flex h-96 w-full gap-3 p-3">
            <div className="w-64 shrink-0">
              <PetRunCard
                client={client}
                run={{
                  ...run,
                  brief: 'Remove the outdated shape from the flowchart.',
                  proposals: [
                    {
                      id: '8eadd6a1-e91a-4be5-b3c4-a37d341b6d51',
                      capability: 'canvas.edit',
                      description: 'Edit canvas Release flow',
                      preview: {
                        kind: 'canvas',
                        itemId: run.itemId,
                        preview: {
                          revision: { docId: '66e6d2d7-de82-457d-bc6c-ba636f827096', headSeq: '4' },
                          changes: [
                            {
                              before: outdatedShape,
                              after: { ...outdatedShape, isDeleted: true, version: 2 },
                            },
                          ],
                        },
                      },
                      status: 'stale',
                    },
                  ],
                }}
                onUpdate={() => undefined}
              />
            </div>
            <PetCanvasReviewPane className="flex-1" />
          </div>
        )}
      </PetCanvasReviewLayout>
    </AuthOverrideProvider>
  ),
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Review drawing' }));
    const review = within(await canvas.findByRole('region', { name: 'Drawing review' }));
    review.getByText('The canvas changed. Refresh the draft to review it again.');
    review.getByRole('button', { name: 'Refresh draft' });
    if (review.queryByRole('button', { name: 'Apply drawing' }) !== null) {
      throw new Error('The stale drawing could still be approved.');
    }
  },
};

const browseId = '4b152694-69f1-4bb9-a457-47dabb23b315';
const unsupportedAddress = 'https://forms.example.org/requests?section=account';
const changedAddress = 'https://forms.example.org/requests/edit';
const browserRun: PetRunResponse = {
  ...run,
  status: 'failed',
  brief: 'Complete the website form.',
  proposals: [
    {
      id: browseId,
      capability: 'browser.browse',
      description: 'Read the reviewed website',
      status: 'applied',
      preview: {},
      receipt: JSON.stringify({
        actionId: browseId,
        visit: { url: unsupportedAddress },
        page: { forms: [{ supported: false }], citation: 'https://another.example.org/' },
      }),
    },
    {
      id: '8eadd6a1-e91a-4be5-b3c4-a37d341b6d51',
      capability: 'browser.submitForm',
      description: 'Submit the reviewed form',
      status: 'refused',
      preview: {
        proposal: { pageUrl: changedAddress, target: 'https://forms.example.org/submit' },
      },
    },
    {
      id: 'b00d9bfe-2300-4fa1-a874-536ed20a9256',
      capability: 'browser.submitForm',
      description: 'A form without a safe page address',
      status: 'refused',
      preview: { proposal: { pageUrl: 'javascript:alert(1)' } },
    },
  ],
};

export const ContinueWebsiteManually = {
  render: (): ReactNode => (
    <div className="w-full max-w-lg p-3">
      <PetRunCard
        client={{
          ...client,
          query: (endpoint) => Promise.resolve(endpoint.schema.parse(browserRun)),
        }}
        run={{
          ...browserRun,
          proposals: browserRun.proposals.map((proposal) => ({
            ...proposal,
            preview: {},
            receipt: null,
          })),
        }}
        onUpdate={() => undefined}
      />
    </div>
  ),
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    await canvas.findByText('A form on this page needs you to complete it in your browser.');
    await canvas.findByText(
      'Your pet couldn’t submit the form. Open the reviewed page to continue manually.',
    );
    const links = canvas.getAllByRole('link', { name: 'Open website' });
    if (
      links.length !== 2 ||
      links[0]?.getAttribute('href') !== unsupportedAddress ||
      links[1]?.getAttribute('href') !== changedAddress ||
      links.some((link) => link.getAttribute('rel') !== 'noopener noreferrer')
    ) {
      throw new Error('Manual continuation must open the saved page in a separate tab.');
    }
  },
};
