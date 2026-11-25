import { createNixClient, petConnectionSchema } from '@nix/api-client';
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { PetWorkTools } from '../../../pets/work-tools/pet-work-tools';

it.each(['planned', 'adopted', 'completed', 'failed'])(
  'keeps a %s plan call out of the legacy approval and cleanup executor',
  (status) => {
    const fetch = vi.fn(() => Promise.reject(new Error('No legacy request is allowed')));
    const client = createNixClient({
      baseUrl: 'http://nix.invalid',
      fetch,
      tokens: {
        getAccessToken: () => Promise.resolve(null),
        refreshAccessToken: () => Promise.resolve(null),
      },
    });
    const runId = '11111111-1111-4111-8111-111111111111';
    const workspaceId = '22222222-2222-4222-8222-222222222222';
    const runtime = petConnectionSchema.parse({
      status: 'connected',
      reason: '',
      canConnect: false,
      tools: [
        {
          id: 'stored-tool',
          arguments: '{"operation":"build_blueprint"}',
          status,
          result: '{"internalLedger":"not a new approval"}',
          claimId: '',
          ...(status === 'planned'
            ? {}
            : {
                planBinding: {
                  toolId: 'stored-tool',
                  runId,
                  planId: runId,
                  planVersion: 1,
                  reviewDigest: 'digest-one',
                  stepId: runId,
                },
              }),
        },
      ],
    });
    render(
      <PetWorkTools
        runtime={runtime}
        workspaceId={workspaceId}
        petId={runId}
        client={client}
        onChange={vi.fn()}
        applyWithoutAsking
      />,
    );
    expect(
      screen.queryByRole('button', { name: /Approve|Apply|Clean|Remove/u }),
    ).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('internalLedger');
    if (status !== 'planned')
      expect(screen.getByRole('link')).toHaveAttribute(
        'href',
        `/w/${workspaceId}/pet/plans/${runId}/review`,
      );
  },
);
