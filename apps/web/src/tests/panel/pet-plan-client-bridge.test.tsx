import { createNixClient, type PetPlanResponse } from '@nix/api-client';
import { requestUrl } from '@nix/web-foundation/testing/request-url';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { preparedPlanFixture } from '../../pages/pet-plan-card.stories';
import { PetPlanClientBridge } from '../../panel/pet-plan-client-bridge';

const token = () => Promise.resolve('synthetic-owner-session');
vi.mock('@nix/web-platform/auth/auth-provider', () => ({
  useAuth: () => ({ getAccessToken: token }),
}));
const requestId = 'eeadd6a1-e91a-4be5-b3c4-a37d341b6d51';
const target = '/api/v1/items/4dffbc88-ea17-4299-96dc-8bac562dd9d0/body';
const body = '{"markdown":"Exact prepared content.\\n"}';
const intent = {
  requestId,
  childId: 1,
  destination: 'core',
  method: 'POST',
  target,
  body,
  headers: {},
  dispatchPermit: 'synthetic-exact-permit',
};

beforeEach(() => {
  sessionStorage.clear();
});

function setup({
  approved = true,
  applying = false,
  uncertain = false,
  held,
  collab = false,
}: {
  readonly approved?: boolean;
  readonly applying?: boolean;
  readonly uncertain?: boolean;
  readonly held?: Promise<void>;
  readonly collab?: boolean;
} = {}) {
  if (preparedPlanFixture.plan == null) throw new Error('Fixture requires a plan');
  const step = preparedPlanFixture.plan.steps[0];
  if (step === undefined) throw new Error('Fixture requires a step');
  const run: PetPlanResponse = {
    ...preparedPlanFixture,
    status: approved ? 'waiting_for_handoff' : 'waiting_for_approval',
    plan: {
      ...preparedPlanFixture.plan,
      status: approved ? 'approved' : 'awaiting_review',
      steps: [
        {
          ...step,
          capability: 'workspace.remember',
          executor: 'client',
          status: applying ? 'applying' : 'pending',
        },
      ],
    },
  };
  const effects = vi.fn<(value: RequestInit | undefined) => void>();
  const effectUrls = vi.fn<(url: string) => void>();
  const claims = vi.fn();
  const results = vi.fn<(value: unknown) => void>();
  let recorded = false;
  const requestedIntent = collab
    ? {
        ...intent,
        destination: 'collab',
        target: '/documents/4dffbc88-ea17-4299-96dc-8bac562dd9d0/updates',
      }
    : intent;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(requestUrl(input));
    const path = url.pathname;
    if (path === requestedIntent.target || path === `/collab${requestedIntent.target}`) {
      effects(init);
      effectUrls(url.href);
      if (uncertain) throw new Error('Synthetic response lost');
      return Response.json({ saved: true });
    }
    if (path.endsWith('/claim')) {
      claims();
      return Response.json({
        run,
        claimId: requestId,
        executionId: requestId,
        stepId: step.id,
        capability: step.capability,
        arguments: step.arguments,
        preview: step.effect.parameters,
        executor: 'client',
        dispatchContext: 'synthetic-step-context',
      });
    }
    if (path.endsWith('/io')) {
      await held;
      return Response.json(recorded ? null : requestedIntent);
    }
    if (path.endsWith('/io/result')) {
      const result: unknown =
        typeof init?.body === 'string' ? await new Response(init.body).json() : undefined;
      results(result);
      recorded = true;
      return Response.json({ recorded: true });
    }
    return Response.json(run);
  };
  if (collab) vi.stubGlobal('fetch', fetcher);
  const client = createNixClient({
    baseUrl: 'http://nix.invalid',
    tokens: { getAccessToken: token, refreshAccessToken: token },
    fetch: fetcher,
  });
  const update = vi.fn();
  const show = (current = run) => (
    <PetPlanClientBridge client={client} run={current} onUpdate={update} />
  );
  const rendered = render(show());
  return {
    ...rendered,
    run,
    effects,
    effectUrls,
    claims,
    results,
    update,
    rerenderRun: (current: PetPlanResponse) => {
      rendered.rerender(show(current));
    },
    remount: () => render(show()),
  };
}

it('dispatches no request or claim before the whole plan decision', async () => {
  const { effects, claims } = setup({ approved: false });
  await act(() => Promise.resolve());
  expect(claims).not.toHaveBeenCalled();
  expect(effects).not.toHaveBeenCalled();
});

it('claims once and dispatches the exact prepared body with normal owner authentication', async () => {
  const { effects, claims, results } = setup();
  await waitFor(() => {
    expect(results).toHaveBeenCalledTimes(1);
  });
  expect(claims).toHaveBeenCalledTimes(1);
  expect(effects).toHaveBeenCalledTimes(1);
  expect(effects.mock.calls[0]?.[0]?.body).toBe(body);
  const headers = new Headers(effects.mock.calls[0]?.[0]?.headers);
  expect(headers.get('Authorization')).toBe('Bearer synthetic-owner-session');
  expect(headers.get('X-Nix-Pet-Plan-Request')).toBe('synthetic-exact-permit');
  expect(results.mock.calls[0]?.[0]).toMatchObject({ requestId, status: 200 });
});

it('relays collaboration intents through the fixed service path with the exact body and owner credential', async () => {
  const { effects, effectUrls, results } = setup({ collab: true });
  await waitFor(() => {
    expect(results).toHaveBeenCalledTimes(1);
  });
  expect(effectUrls).toHaveBeenCalledExactlyOnceWith(
    `${window.location.origin}/collab/documents/4dffbc88-ea17-4299-96dc-8bac562dd9d0/updates`,
  );
  expect(effects.mock.calls[0]?.[0]?.body).toBe(body);
  const headers = new Headers(effects.mock.calls[0]?.[0]?.headers);
  expect(headers.get('Authorization')).toBe('Bearer synthetic-owner-session');
  expect(headers.get('X-Nix-Pet-Plan-Request')).toBe('synthetic-exact-permit');
});

it('resumes an existing applying client step without claiming or replaying another operation', async () => {
  const { effects, claims, results } = setup({ applying: true });
  await waitFor(() => {
    expect(results).toHaveBeenCalledTimes(1);
  });
  expect(claims).not.toHaveBeenCalled();
  expect(effects).toHaveBeenCalledTimes(1);
});

it.each(['cancelled', 'superseded'])(
  'does not dispatch a held intent after the plan becomes %s',
  async (status) => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { effects, run, rerenderRun } = setup({ applying: true, held });
    await act(() => Promise.resolve());
    if (run.plan == null) throw new Error('Fixture requires a plan');
    rerenderRun({ ...run, status: 'cancelled', plan: { ...run.plan, status } });
    await act(async () => {
      release?.();
      await held;
    });
    expect(effects).not.toHaveBeenCalled();
  },
);

it('does not repeat an uncertain request after the owner client remounts', async () => {
  const { effects, unmount, remount } = setup({ applying: true, uncertain: true });
  expect(await screen.findByRole('status')).toHaveTextContent('Device execution paused');
  expect(effects).toHaveBeenCalledTimes(1);
  unmount();
  remount();
  expect(await screen.findByRole('status')).toHaveTextContent('will not repeat it automatically');
  expect(effects).toHaveBeenCalledTimes(1);
});

it('clears the previous device problem when a different frozen plan is prepared', async () => {
  const { run, rerenderRun } = setup({ applying: true, uncertain: true });
  expect(await screen.findByRole('status')).toHaveTextContent('Device execution paused');
  if (run.plan == null) throw new Error('Fixture requires a plan');
  rerenderRun({
    ...run,
    status: 'waiting_for_approval',
    plan: { ...run.plan, version: 2, reviewDigest: 'new-frozen-review', status: 'awaiting_review' },
  });
  expect(screen.queryByText(/Device execution paused/u)).not.toBeInTheDocument();
});
