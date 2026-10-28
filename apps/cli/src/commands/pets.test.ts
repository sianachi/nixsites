import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { outputOptions } from '../output.ts';
import { executePetToolRun, petCommand, petToolRun } from './pets.ts';
import { openSession } from '../session.ts';
import { makeProfile } from './cli.test-helper.ts';

const CORE = 'http://core.nix.test';
const COLLAB = 'http://collab.nix.test';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const PET = '33333333-3333-4333-8333-333333333333';
const TOOL = 'tool-1';

const server = setupServer(
  http.post(`${CORE}/public/v1/auth/token`, () =>
    HttpResponse.json({ accessToken: 'jwt-1', tokenType: 'Bearer', expiresInSeconds: 600 }),
  ),
);
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => {
  server.close();
});

describe('pet commands', () => {
  it('uses an explicit interactive token without storing it or widening PAT permissions', async () => {
    let payload: unknown;
    server.use(
      http.post('http://nix.test/api/v1/me/pets/runtime', async ({ request }) => {
        expect(request.headers.get('authorization')).toBe('Bearer ephemeral-session');
        payload = await request.json();
        return HttpResponse.json({
          provider: 'chatgpt',
          status: 'connected',
          reason: 'Connected',
          canConnect: false,
        });
      }),
    );
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await petCommand(
      undefined,
      'send',
      {
        apiUrl: 'http://nix.test',
        workspace: '11111111-1111-4111-8111-111111111111',
        pet: '22222222-2222-4222-8222-222222222222',
        message: 'Make a plan',
        workspaceTools: true,
        model: 'account-model',
      },
      { json: true, isTty: false },
      { env: { NIX_SESSION_TOKEN: 'ephemeral-session' } },
    );
    expect(payload).toMatchObject({
      operation: 'send',
      text: 'Make a plan',
      workspaceAccess: true,
      model: 'account-model',
    });
    expect(output).toHaveBeenCalled();
  });
  it('rejects unknown operations before contacting the service', async () => {
    await expect(petCommand(undefined, 'exec', {}, { json: true, isTty: false })).rejects.toThrow(
      'Choose a pet operation',
    );
  });
  it('forwards a pending tool_claim/tool_result pair without a conversation mode', async () => {
    const calls: Record<string, unknown>[] = [];
    server.use(
      http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        calls.push(body);
        return HttpResponse.json({
          provider: 'chatgpt',
          status: 'connected',
          reason: 'Connected',
          canConnect: false,
          mode: body.mode,
        });
      }),
    );
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await petCommand(
      undefined,
      'tool_claim',
      { apiUrl: CORE, workspace: WORKSPACE, pet: PET, toolId: TOOL, requestId: 'req-1' },
      { json: true, isTty: false },
      { env: { NIX_SESSION_TOKEN: 'ephemeral-session' } },
    );
    await petCommand(
      undefined,
      'tool_result',
      {
        apiUrl: CORE,
        workspace: WORKSPACE,
        pet: PET,
        toolId: TOOL,
        requestId: 'req-1',
        toolResult: 'done',
        toolSuccess: true,
      },
      { json: true, isTty: false },
      { env: { NIX_SESSION_TOKEN: 'ephemeral-session' } },
    );
    await petCommand(
      undefined,
      'read',
      { apiUrl: CORE, workspace: WORKSPACE, pet: PET },
      { json: true, isTty: false },
      { env: { NIX_SESSION_TOKEN: 'ephemeral-session' } },
    );
    expect(calls.map((call) => call.operation)).toEqual(['tool_claim', 'tool_result', 'read']);
    expect(calls[0]).toMatchObject({
      workspaceId: WORKSPACE,
      petId: PET,
      toolId: TOOL,
      requestId: 'req-1',
      mode: '',
    });
    expect(calls[1]).toMatchObject({
      toolId: TOOL,
      requestId: 'req-1',
      toolResult: 'done',
      toolSuccess: true,
    });
    expect(calls[2]).toMatchObject({ workspaceId: WORKSPACE, petId: PET, mode: '' });
    expect(output).toHaveBeenCalled();
  });
  it('rejects tool_claim and tool_result before contacting the service when --tool-id is missing', async () => {
    await expect(
      petCommand(
        undefined,
        'tool_claim',
        { apiUrl: CORE, workspace: WORKSPACE, pet: PET },
        { json: true, isTty: false },
        { env: { NIX_SESSION_TOKEN: 'ephemeral-session' } },
      ),
    ).rejects.toThrow('Provide --tool-id.');
    await expect(
      petCommand(
        undefined,
        'tool_result',
        { apiUrl: CORE, workspace: WORKSPACE, pet: PET, toolId: TOOL },
        { json: true, isTty: false },
        { env: { NIX_SESSION_TOKEN: 'ephemeral-session' } },
      ),
    ).rejects.toThrow('Provide --tool-id and --tool-result.');
  });
  it('sends rename and resume_history with their title and archive, and refuses them incomplete', async () => {
    const payloads: unknown[] = [];
    server.use(
      http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
        payloads.push(await request.json());
        return HttpResponse.json({
          provider: 'chatgpt',
          status: 'connected',
          reason: 'Connected',
          canConnect: false,
          title: 'Sprint review',
        });
      }),
    );
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const base = { apiUrl: CORE, workspace: WORKSPACE, pet: PET };
    const deps = { env: { NIX_SESSION_TOKEN: 'ephemeral-session' } };
    const archive = '44444444-4444-4444-8444-444444444444';
    await petCommand(
      undefined,
      'rename',
      { ...base, title: 'Sprint review' },
      { json: true, isTty: false },
      deps,
    );
    await petCommand(
      undefined,
      'resume_history',
      { ...base, historyId: archive },
      { json: true, isTty: false },
      deps,
    );
    expect(payloads[0]).toMatchObject({ operation: 'rename', text: 'Sprint review' });
    expect(payloads[0]).not.toHaveProperty('historyId');
    expect(payloads[1]).toMatchObject({ operation: 'resume_history', historyId: archive });
    await expect(
      petCommand(undefined, 'rename', base, { json: true, isTty: false }, deps),
    ).rejects.toThrow('Provide --title.');
    await expect(
      petCommand(undefined, 'resume_history', base, { json: true, isTty: false }, deps),
    ).rejects.toThrow('Provide --history-id.');
    expect(payloads).toHaveLength(2);
  });
  it('drives watch through a GET long-poll and prints the revision', async () => {
    let query: URLSearchParams | undefined;
    server.use(
      http.get(`${CORE}/api/v1/me/pets/runtime/watch`, ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json({
          provider: 'chatgpt',
          status: 'connected',
          reason: 'Connected',
          canConnect: false,
          revision: 7,
        });
      }),
    );
    const result = await capture(() =>
      petCommand(
        undefined,
        'watch',
        { apiUrl: CORE, workspace: WORKSPACE, pet: PET, after: 3 },
        { json: true, isTty: false },
        { env: { NIX_SESSION_TOKEN: 'ephemeral-session' } },
      ),
    );
    expect(query?.get('workspaceId')).toBe(WORKSPACE);
    expect(query?.get('petId')).toBe(PET);
    expect(query?.has('mode')).toBe(false);
    expect(query?.get('after')).toBe('3');
    expect(result).toMatchObject({ revision: 7 });
  });
  it('requires --workspace and --pet for watch before contacting the service', async () => {
    await expect(petCommand(undefined, 'watch', {}, { json: true, isTty: false })).rejects.toThrow(
      'Provide --workspace and --pet.',
    );
  });
});

describe('note-scoped pet commands', () => {
  it('roots sends on the note, defaults to read-only, and requires an explicit edit choice', async () => {
    const rootItem = '66666666-6666-4666-8666-666666666666';
    const payloads: unknown[] = [];
    server.use(
      http.post(`${CORE}/api/v1/me/pets/runtime/note`, async ({ request }) => {
        payloads.push(await request.json());
        return HttpResponse.json(runtimeResponse([]));
      }),
    );
    for (const allowEdits of [false, true]) {
      await capture(() =>
        petCommand(
          undefined,
          'send',
          {
            apiUrl: CORE,
            workspace: WORKSPACE,
            pet: PET,
            message: 'Explain this note',
            rootItem,
            allowEdits,
          },
          outputOptions(true),
          { env: { NIX_SESSION_TOKEN: 'ephemeral-session' } },
        ),
      );
    }
    expect(payloads[0]).toMatchObject({
      rootItemId: rootItem,
      itemId: rootItem,
      readOnly: true,
      workspaceAccess: true,
    });
    expect(payloads[1]).toMatchObject({ rootItemId: rootItem, readOnly: false });
  });

  it('rejects malformed roots and edits without a note before contacting Core', async () => {
    await expect(
      petCommand(
        undefined,
        'send',
        { workspace: WORKSPACE, pet: PET, message: 'Hi', rootItem: 'outside' },
        outputOptions(true),
      ),
    ).rejects.toThrow('--root-item must be an item UUID.');
    await expect(
      petCommand(
        undefined,
        'send',
        { workspace: WORKSPACE, pet: PET, message: 'Hi', allowEdits: true },
        outputOptions(true),
      ),
    ).rejects.toThrow('--allow-edits requires --root-item.');
  });
});

const withProfile = () => makeProfile({ apiUrl: CORE, collabUrl: COLLAB, token: 'nixpat_abc' });

async function capture(body: () => Promise<void>): Promise<unknown> {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  });
  try {
    await body();
    return JSON.parse(lines.join(''));
  } finally {
    spy.mockRestore();
  }
}

function listItemsArgs(): string {
  return JSON.stringify({
    operation: 'list_items',
    itemId: '',
    parentId: '',
    title: '',
    markdown: '',
    query: '',
    propertiesJson: '',
  });
}

function pendingTool(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TOOL,
    arguments: listItemsArgs(),
    status: 'pending',
    result: '',
    claimId: '',
    ...overrides,
  };
}

function runtimeResponse(tools: unknown[]): Record<string, unknown> {
  return {
    provider: 'chatgpt',
    status: 'connected',
    reason: 'Connected',
    canConnect: false,
    tools,
  };
}

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: WORKSPACE,
    parentId: null,
    type: 'note',
    title: 'Kickoff',
    hasChildren: false,
    seq: 1000,
    lifecycleState: 'active',
    properties: {},
    createdAt: '2026-08-19T09:00:00.000Z',
    updatedAt: '2026-08-19T09:00:00.000Z',
    ...overrides,
  };
}

describe('pet tools run', () => {
  it.each([true, false])(
    'rechecks the claimed read hold for automatic approval=%s and preserves manual approval',
    async (automatic) => {
      const itemId = String(item().id);
      const argumentsText = JSON.stringify({
        operation: 'rename_item',
        itemId,
        parentId: '',
        title: 'Reviewed name',
        markdown: '',
        query: '',
        propertiesJson: '',
        specJson: '',
      });
      const tool = pendingTool({ arguments: argumentsText });
      const calls: string[] = [];
      const results: Record<string, unknown>[] = [];
      const writes: unknown[] = [];
      server.use(
        http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          calls.push(String(body.operation));
          if (body.operation === 'read')
            return HttpResponse.json({
              ...runtimeResponse([tool]),
              lockedRead: false,
            });
          if (body.operation === 'tool_claim')
            return HttpResponse.json({
              ...runtimeResponse([{ ...tool, status: 'claimed', claimId: body.requestId }]),
              lockedRead: true,
            });
          results.push(body);
          return HttpResponse.json({
            ...runtimeResponse([
              {
                ...tool,
                status: body.toolSuccess ? 'completed' : 'failed',
                result: body.toolResult,
              },
            ]),
            lockedRead: true,
          });
        }),
        http.get(`${CORE}/api/v1/items/${itemId}`, () => HttpResponse.json(item())),
        http.patch(`${CORE}/api/v1/items/${itemId}`, async ({ request }) => {
          writes.push(await request.json());
          return HttpResponse.json(item({ title: 'Reviewed name' }));
        }),
      );
      const session = openSession({
        profile: { apiUrl: CORE, token: 'pat' },
        bearerToken: 'session',
      });
      await executePetToolRun(
        session,
        WORKSPACE,
        PET,
        TOOL,
        'approve',
        automatic ? { arguments: argumentsText } : undefined,
      );
      expect(calls).toEqual(['read', 'tool_claim', 'tool_result']);
      expect(writes).toHaveLength(automatic ? 0 : 1);
      expect(results).toHaveLength(1);
      expect(results[0]?.toolSuccess).toBe(!automatic);
      if (automatic)
        expect(results[0]?.toolResult).toBe(
          "Earlier reads need the owner's review before changes. No action ran. Do not retry without approval.",
        );
    },
  );

  it('keeps the eval-approved fingerprint instead of approving a fresh structure snapshot', async () => {
    const itemId = String(item().id);
    const argumentsText = JSON.stringify({
      operation: 'add_view',
      itemId,
      parentId: '',
      title: '',
      markdown: '',
      query: '',
      propertiesJson: '',
      specJson: JSON.stringify({ views: [{ kind: 'list', name: 'Next' }] }),
    });
    const tool = pendingTool({ arguments: argumentsText });
    const results: Record<string, unknown>[] = [];
    server.use(
      http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        if (body.operation === 'read') return HttpResponse.json(runtimeResponse([tool]));
        if (body.operation === 'tool_claim')
          return HttpResponse.json(
            runtimeResponse([{ ...tool, status: 'claimed', claimId: body.requestId }]),
          );
        results.push(body);
        return HttpResponse.json(runtimeResponse([{ ...tool, status: 'failed' }]));
      }),
      http.get(`${CORE}/api/v1/items/${itemId}`, () => HttpResponse.json(item())),
      http.get(`${CORE}/api/v1/items/${itemId}/schema`, () =>
        HttpResponse.json({
          properties: [],
          declared: [],
          inherit: true,
        }),
      ),
      http.get(`${CORE}/api/v1/items/${itemId}/views`, () =>
        HttpResponse.json({
          views: [],
          unrenderable: [],
          default: '',
          hideDocument: false,
        }),
      ),
    );
    const session = openSession({
      profile: { apiUrl: CORE, token: 'pat' },
      bearerToken: 'session',
    });
    await executePetToolRun(session, WORKSPACE, PET, TOOL, 'approve', {
      arguments: argumentsText,
      fingerprint: 'the earlier snapshot',
    });
    expect(results).toEqual([
      expect.objectContaining({
        toolSuccess: false,
        toolResult: 'The item changed since you approved this. Ask the pet to look again.',
      }),
    ]);
  });

  it.each(['changed request', 'locked read'] as const)(
    'refuses eval auto-approval after %s before claiming',
    async (change) => {
      const calls: string[] = [];
      const argumentsText = listItemsArgs();
      const tool = pendingTool({ arguments: argumentsText });
      server.use(
        http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
          const body = (await request.json()) as { operation: string };
          calls.push(body.operation);
          return HttpResponse.json({
            ...runtimeResponse([
              change === 'changed request' ? { ...tool, arguments: `${argumentsText} ` } : tool,
            ]),
            lockedRead: change === 'locked read',
          });
        }),
      );
      const session = openSession({
        profile: { apiUrl: CORE, token: 'pat' },
        bearerToken: 'session',
      });
      await expect(
        executePetToolRun(session, WORKSPACE, PET, TOOL, 'approve', {
          arguments: argumentsText,
        }),
      ).rejects.toThrow(
        change === 'changed request'
          ? 'Tool changed after evaluation preview.'
          : 'The conversation read locked content after evaluation preview.',
      );
      expect(calls).toEqual(['read']);
    },
  );

  it('dry run prints the preview and performs no runtime write', async () => {
    const profile = await withProfile();
    try {
      const calls: string[] = [];
      server.use(
        http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
          const body = (await request.json()) as { operation: string };
          calls.push(body.operation);
          return HttpResponse.json(runtimeResponse([pendingTool()]));
        }),
      );
      const result = await capture(() =>
        petToolRun(
          'default',
          TOOL,
          { workspace: WORKSPACE, pet: PET },
          outputOptions(true, { isTTY: false }),
          { env: profile.env },
        ),
      );
      expect(calls).toEqual(['read']);
      expect(result).toMatchObject({
        headline: 'I will list the top-level items in this workspace to find what to work on.',
        counts: { writes: 0 },
      });
    } finally {
      await profile.done();
    }
  });

  it.each([
    [{ operation: 'list_templates', query: 'reading log' }, 0],
    [{ operation: 'list_templates', query: '' }, 0],
    [{ operation: 'read_template', itemId: '11111111-1111-4111-8111-111111111111' }, 0],
    [
      {
        operation: 'apply_template',
        itemId: '11111111-1111-4111-8111-111111111111',
        title: 'Reading log',
      },
      1,
    ],
    [{ operation: 'read_structure', itemId: '11111111-1111-4111-8111-111111111111' }, 0],
    [
      {
        operation: 'create_structured',
        title: 'Reading log',
        specJson: '{"recipe":"board","fields":[]}',
      },
      1,
    ],
    [
      {
        operation: 'add_view',
        itemId: '11111111-1111-4111-8111-111111111111',
        specJson: '{"views":[{"kind":"list"}]}',
      },
      1,
    ],
    [
      {
        operation: 'create_entries',
        parentId: '11111111-1111-4111-8111-111111111111',
        specJson: '{"entries":[{"title":"First"}]}',
      },
      1,
    ],
    [
      {
        operation: 'add_fields',
        itemId: '11111111-1111-4111-8111-111111111111',
        specJson: '{"fields":[]}',
      },
      0,
    ],
    [
      {
        operation: 'edit_form',
        itemId: '11111111-1111-4111-8111-111111111111',
        specJson: '{"viewId":"form","form":{"pages":[]}}',
      },
      0,
    ],
    [
      {
        operation: 'set_recurrence',
        itemId: '11111111-1111-4111-8111-111111111111',
        specJson: '{"frequency":"weekly","interval":2}',
      },
      0,
    ],
  ])('prints the shared preview model for %o', async (overrides, writes) => {
    const profile = await withProfile();
    try {
      server.use(
        http.get(`${CORE}/api/v1/items/:itemId`, ({ params }) =>
          HttpResponse.json(item({ id: String(params.itemId) })),
        ),
        http.get(`${CORE}/api/v1/items/:itemId/schema`, () =>
          HttpResponse.json({ properties: [], declared: [], inherit: true }),
        ),
        http.get(`${CORE}/api/v1/items/:itemId/views`, () =>
          HttpResponse.json({ views: [], unrenderable: [], default: 'document' }),
        ),
        http.get(`${CORE}/api/v1/workspaces/:workspaceId/items`, () =>
          HttpResponse.json({ items: [], nextCursor: null }),
        ),
        http.get(`${CORE}/api/v1/workspaces/:workspaceId/templates`, () =>
          HttpResponse.json({
            templates: [
              {
                id: '11111111-1111-4111-8111-111111111111',
                workspaceId: WORKSPACE,
                title: 'Reading log',
                description: null,
                origin: 'user',
                revision: 1,
                includeBody: false,
                includeChildren: false,
                fieldCount: 0,
                viewCount: 0,
                childCount: 0,
                viewKinds: [],
                capabilities: { canEdit: true, canDelete: true, canExport: true, canApply: true },
                updatedAt: '2026-08-19T09:00:00Z',
              },
            ],
            capabilities: { canManage: true },
          }),
        ),
        http.post(`${CORE}/api/v1/templates/:templateId/preflight`, () =>
          HttpResponse.json({
            templateId: '11111111-1111-4111-8111-111111111111',
            templateRevision: 1,
            mode: 'create',
            additions: { fields: 0, views: 0, items: 0 },
            conflicts: [],
            canApply: true,
          }),
        ),
        http.post(`${CORE}/api/v1/me/pets/runtime`, () =>
          HttpResponse.json(
            runtimeResponse([
              pendingTool({
                arguments: JSON.stringify({
                  itemId: '',
                  parentId: '',
                  title: '',
                  markdown: '',
                  query: '',
                  propertiesJson: '',
                  ...overrides,
                }),
              }),
            ]),
          ),
        ),
      );
      const result = await capture(() =>
        petToolRun(
          'default',
          TOOL,
          { workspace: WORKSPACE, pet: PET },
          outputOptions(true, { isTTY: false }),
          { env: profile.env },
        ),
      );
      expect(result).toHaveProperty('headline');
      expect(result).toHaveProperty('destination');
      expect(result).toMatchObject({ counts: { writes } });
    } finally {
      await profile.done();
    }
  });

  it('previews with an interactive apiUrl/NIX_SESSION_TOKEN session and no stored profile', async () => {
    const calls: string[] = [];
    server.use(
      http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
        expect(request.headers.get('authorization')).toBe('Bearer ephemeral-session');
        const body = (await request.json()) as { operation: string };
        calls.push(body.operation);
        return HttpResponse.json(runtimeResponse([pendingTool()]));
      }),
    );
    const result = await capture(() =>
      petToolRun(
        undefined,
        TOOL,
        { apiUrl: CORE, workspace: WORKSPACE, pet: PET },
        outputOptions(true, { isTTY: false }),
        { env: { NIX_SESSION_TOKEN: 'ephemeral-session' } },
      ),
    );
    expect(calls).toEqual(['read']);
    expect(result).toMatchObject({
      headline: 'I will list the top-level items in this workspace to find what to work on.',
    });
  });

  it('claims before executing and never runs when the claim receipt does not match', async () => {
    const profile = await withProfile();
    try {
      const calls: string[] = [];
      server.use(
        http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
          const body = (await request.json()) as { operation: string };
          calls.push(body.operation);
          if (body.operation === 'read') return HttpResponse.json(runtimeResponse([pendingTool()]));
          if (body.operation === 'tool_claim')
            // A stale or lost claim response: the receipt names someone else's claim.
            return HttpResponse.json(
              runtimeResponse([pendingTool({ status: 'claimed', claimId: 'someone-elses-claim' })]),
            );
          throw new Error(`Unexpected operation ${body.operation}`);
        }),
      );
      await expect(
        petToolRun(
          'default',
          TOOL,
          { workspace: WORKSPACE, pet: PET, approve: true },
          outputOptions(true, { isTTY: false }),
          { env: profile.env },
        ),
      ).rejects.toThrow('Tool was claimed elsewhere.');
      expect(calls).toEqual(['read', 'tool_claim']);
    } finally {
      await profile.done();
    }
  });

  it('posts a declined result without executing', async () => {
    const profile = await withProfile();
    try {
      const calls: { operation: string; body: Record<string, unknown> }[] = [];
      server.use(
        http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          calls.push({ operation: body.operation as string, body });
          if (body.operation === 'read') return HttpResponse.json(runtimeResponse([pendingTool()]));
          if (body.operation === 'tool_claim')
            return HttpResponse.json(
              runtimeResponse([pendingTool({ status: 'claimed', claimId: body.requestId })]),
            );
          if (body.operation === 'tool_result')
            return HttpResponse.json(
              runtimeResponse([
                pendingTool({ status: 'failed', result: body.toolResult as string }),
              ]),
            );
          throw new Error(`Unexpected operation ${String(body.operation)}`);
        }),
      );
      const result = await capture(() =>
        petToolRun(
          'default',
          TOOL,
          { workspace: WORKSPACE, pet: PET, decline: true },
          outputOptions(true, { isTTY: false }),
          { env: profile.env },
        ),
      );
      expect(calls.map((call) => call.operation)).toEqual(['read', 'tool_claim', 'tool_result']);
      const resultCall = calls[2];
      expect(resultCall?.body).toMatchObject({
        toolResult: 'Declined by the user. Do not retry this change unless asked.',
        toolSuccess: false,
      });
      expect(result).toBeDefined();
    } finally {
      await profile.done();
    }
  });

  it('posts the uncertain-outcome sentence and success false when execution throws', async () => {
    const profile = await withProfile();
    try {
      const calls: { operation: string; body: Record<string, unknown> }[] = [];
      server.use(
        http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          calls.push({ operation: body.operation as string, body });
          if (body.operation === 'read')
            return HttpResponse.json(
              runtimeResponse([
                pendingTool({
                  arguments: JSON.stringify({
                    operation: 'read_item',
                    itemId: '11111111-1111-4111-8111-111111111111',
                    parentId: '',
                    title: '',
                    markdown: '',
                    query: '',
                    propertiesJson: '',
                  }),
                }),
              ]),
            );
          if (body.operation === 'tool_claim')
            return HttpResponse.json(
              runtimeResponse([pendingTool({ status: 'claimed', claimId: body.requestId })]),
            );
          if (body.operation === 'tool_result')
            return HttpResponse.json(
              runtimeResponse([
                pendingTool({ status: 'failed', result: body.toolResult as string }),
              ]),
            );
          throw new Error(`Unexpected operation ${String(body.operation)}`);
        }),
        // The executor's own read of the target item fails with a server error: the outcome
        // is uncertain, not a `WorkspaceToolRefusal` and not a success.
        http.get(`${CORE}/api/v1/items/11111111-1111-4111-8111-111111111111`, () =>
          HttpResponse.json({ code: 'server_error', detail: 'boom' }, { status: 500 }),
        ),
      );
      const result = await capture(() =>
        petToolRun(
          'default',
          TOOL,
          { workspace: WORKSPACE, pet: PET, approve: true },
          outputOptions(true, { isTTY: false }),
          { env: profile.env },
        ),
      );
      const resultCall = calls[2];
      expect(resultCall?.body).toMatchObject({
        toolResult:
          'The operation failed or its result is uncertain. Inspect Nix before retrying a write. Do not assume success.',
        toolSuccess: false,
      });
      expect(result).toBeDefined();
    } finally {
      await profile.done();
    }
  });

  it('posts the outcome text and success true after an approved read-only write executes', async () => {
    const profile = await withProfile();
    try {
      const calls: { operation: string; body: Record<string, unknown> }[] = [];
      server.use(
        http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          calls.push({ operation: body.operation as string, body });
          if (body.operation === 'read') return HttpResponse.json(runtimeResponse([pendingTool()]));
          if (body.operation === 'tool_claim')
            return HttpResponse.json(
              runtimeResponse([pendingTool({ status: 'claimed', claimId: body.requestId })]),
            );
          if (body.operation === 'tool_result')
            return HttpResponse.json(
              runtimeResponse([
                pendingTool({ status: 'completed', result: body.toolResult as string }),
              ]),
            );
          throw new Error(`Unexpected operation ${String(body.operation)}`);
        }),
        http.get(`${CORE}/api/v1/workspaces/${WORKSPACE}/items`, () =>
          HttpResponse.json({ items: [item()], nextCursor: null }),
        ),
      );
      const result = await capture(() =>
        petToolRun(
          'default',
          TOOL,
          { workspace: WORKSPACE, pet: PET, approve: true },
          outputOptions(true, { isTTY: false }),
          { env: profile.env },
        ),
      );
      const resultCall = calls[2];
      expect(resultCall?.body).toMatchObject({ toolSuccess: true });
      expect(JSON.parse(resultCall?.body.toolResult as string)).toMatchObject({
        truncated: false,
        items: [{ id: item().id, title: 'Kickoff' }],
      });
      expect(result).toBeDefined();
    } finally {
      await profile.done();
    }
  });

  it('reports the local refusal message when the target is outside the workspace', async () => {
    const profile = await withProfile();
    const otherItem = '44444444-4444-4444-8444-444444444444';
    try {
      const calls: { operation: string; body: Record<string, unknown> }[] = [];
      server.use(
        http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          calls.push({ operation: body.operation as string, body });
          if (body.operation === 'read')
            return HttpResponse.json(
              runtimeResponse([
                pendingTool({
                  arguments: JSON.stringify({
                    operation: 'list_items',
                    itemId: '',
                    parentId: otherItem,
                    title: '',
                    markdown: '',
                    query: '',
                    propertiesJson: '',
                  }),
                }),
              ]),
            );
          if (body.operation === 'tool_claim')
            return HttpResponse.json(
              runtimeResponse([pendingTool({ status: 'claimed', claimId: body.requestId })]),
            );
          if (body.operation === 'tool_result')
            return HttpResponse.json(
              runtimeResponse([
                pendingTool({ status: 'failed', result: body.toolResult as string }),
              ]),
            );
          throw new Error(`Unexpected operation ${String(body.operation)}`);
        }),
        // `otherItem` belongs to a different workspace: the scope guard must refuse locally.
        http.get(`${CORE}/api/v1/items/${otherItem}`, () =>
          HttpResponse.json(
            item({ id: otherItem, workspaceId: '55555555-5555-4555-8555-555555555555' }),
          ),
        ),
      );
      await capture(() =>
        petToolRun(
          'default',
          TOOL,
          { workspace: WORKSPACE, pet: PET, approve: true },
          outputOptions(true, { isTTY: false }),
          { env: profile.env },
        ),
      );
      const resultCall = calls[2];
      expect(resultCall?.body).toMatchObject({
        toolResult: 'The item is outside this workspace. No action was run.',
        toolSuccess: false,
      });
    } finally {
      await profile.done();
    }
  });

  it('rejects resolving a tool call that is no longer pending', async () => {
    const profile = await withProfile();
    try {
      server.use(
        http.post(`${CORE}/api/v1/me/pets/runtime`, () =>
          HttpResponse.json(runtimeResponse([pendingTool({ status: 'completed' })])),
        ),
      );
      await expect(
        petToolRun(
          'default',
          TOOL,
          { workspace: WORKSPACE, pet: PET },
          outputOptions(true, { isTTY: false }),
          { env: profile.env },
        ),
      ).rejects.toThrow(`Tool ${TOOL} is not pending.`);
    } finally {
      await profile.done();
    }
  });

  it('falls back to the unsupported preview when a pending call carries malformed arguments', async () => {
    const profile = await withProfile();
    try {
      server.use(
        http.post(`${CORE}/api/v1/me/pets/runtime`, () =>
          HttpResponse.json(runtimeResponse([pendingTool({ arguments: 'not json' })])),
        ),
      );
      const result = await capture(() =>
        petToolRun(
          'default',
          TOOL,
          { workspace: WORKSPACE, pet: PET },
          outputOptions(true, { isTTY: false }),
          { env: profile.env },
        ),
      );
      expect(result).toMatchObject({
        toolId: TOOL,
        preview:
          'This request is unsupported. Decline it so the companion can try a supported operation.',
      });
    } finally {
      await profile.done();
    }
  });

  it('rejects both --approve and --decline together', async () => {
    const profile = await withProfile();
    try {
      await expect(
        petToolRun(
          'default',
          TOOL,
          { workspace: WORKSPACE, pet: PET, approve: true, decline: true },
          outputOptions(true, { isTTY: false }),
          { env: profile.env },
        ),
      ).rejects.toThrow('Choose either --approve or --decline, not both.');
    } finally {
      await profile.done();
    }
  });
});
