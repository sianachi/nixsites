import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { chatCaseSchema } from '@nix/structure-spec';
import { openSession } from '../session.ts';
import { WorkspaceToolRefusal, type BodyEditPlan, type CompanionPorts } from '@nix/companion';
import { EMPTY_MARKDOWN_IMPORT_SCAN } from '@nix/markdown';
import { viewConfigurationSchema, type TemplateSummary } from '@nix/api-client';
import * as Y from 'yjs';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import { nixSchema } from '@nix/editor-schema';
import {
  declineReason,
  readChatCases,
  runChatCase,
  runChatSuite,
  scopeFixtureQueryViews,
  seedFixtureLinks,
  substituteDates,
  type ChatEvalRuntime,
  type ChatFixture,
} from './pet-eval-chat.ts';

const CORE = 'http://nix.eval.test';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const PET = '33333333-3333-4333-8333-333333333333';
const ROOT = '44444444-4444-4444-8444-444444444444';
const TASKS = '55555555-5555-4555-8555-555555555555';
const DENTIST = '66666666-6666-4666-8666-666666666666';
const OUTSIDE = '77777777-7777-4777-8777-777777777777';

const server = setupServer();
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

const fixture: ChatFixture = {
  rootId: ROOT,
  nodes: new Map([
    ['home', ROOT],
    ['tasks', TASKS],
    ['task-dentist', DENTIST],
  ]),
};

function item(
  id: string,
  parentId: string | null,
  title: string,
  properties: Record<string, unknown> = {},
) {
  return {
    id,
    workspaceId: WORKSPACE,
    parentId,
    title,
    type: 'note',
    hasChildren: false,
    seq: 1000,
    lifecycleState: 'active',
    properties,
    createdAt: '2026-10-08T00:00:00.000Z',
    updatedAt: '2026-10-08T00:00:00.000Z',
  };
}

function toolCall(id: string, args: Record<string, unknown>) {
  return {
    id,
    arguments: JSON.stringify({
      itemId: '',
      parentId: '',
      title: '',
      markdown: '',
      query: '',
      propertiesJson: '',
      specJson: '',
      ...args,
    }),
    status: 'pending',
    result: '',
    claimId: '',
  };
}

function connection(extra: Record<string, unknown> = {}) {
  return { provider: 'chatgpt', status: 'connected', reason: '', canConnect: false, ...extra };
}

function bodyUpdate(text: string): string {
  const doc = prosemirrorJSONToYDoc(
    nixSchema,
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
    'default',
  );
  try {
    return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
  } finally {
    doc.destroy();
  }
}

/** A runtime that offers `tools` one read at a time, then finishes with `answer`. */
function scriptedRuntime(tools: ReturnType<typeof toolCall>[], answer: string) {
  const calls: Record<string, unknown>[] = [];
  const decided = new Map<string, { status: string; claimId: string; result: string }>();
  server.use(
    http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      calls.push(body);
      const current = () => tools.map((tool) => ({ ...tool, ...(decided.get(tool.id) ?? {}) }));
      if (body.operation === 'tool_claim') {
        decided.set(String(body.toolId), {
          status: 'claimed',
          claimId: String(body.requestId),
          result: '',
        });
        return HttpResponse.json(connection({ state: 'thinking', tools: current() }));
      }
      if (body.operation === 'tool_result') {
        decided.set(String(body.toolId), {
          status: body.toolSuccess ? 'completed' : 'failed',
          claimId: String(body.requestId),
          result: String(body.toolResult),
        });
        return HttpResponse.json(connection({ state: 'thinking', tools: current() }));
      }
      if (body.operation === 'read') {
        const pending = tools.some(
          (tool) => (decided.get(tool.id)?.status ?? 'pending') === 'pending',
        );
        return HttpResponse.json(
          connection({
            state: pending ? 'thinking' : 'success',
            tools: current(),
            messages: pending ? [] : [{ id: 'a-1', role: 'assistant', text: answer }],
          }),
        );
      }
      return HttpResponse.json(connection({ state: 'thinking' }));
    }),
  );
  return calls;
}

function runner(): ChatEvalRuntime {
  const session = openSession({
    profile: { apiUrl: CORE, token: 'pat' },
    bearerToken: 'session',
  });
  return {
    session,
    sleep: () => Promise.resolve(),
    today: () => '2026-10-08',
    seed: () => Promise.resolve(fixture),
    teardown: () => Promise.resolve(),
  };
}

describe('pet eval chat', () => {
  it('retains recovery evidence when a template persists before its detail read fails', async () => {
    const tool = toolCall('capture', {
      operation: 'save_as_template',
      itemId: DENTIST,
      title: 'Saved synthetic note',
      specJson: '{"includeSamples":true}',
    });
    const calls = scriptedRuntime([tool], 'Never verified.');
    let resets = 0;
    server.use(
      http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
        const body = (await request.clone().json()) as Record<string, unknown>;
        if (body.operation !== 'reset') return;
        resets += 1;
        return resets === 1
          ? HttpResponse.json(connection({ state: 'idle' }))
          : HttpResponse.json({ title: 'Reset unavailable', status: 503 }, { status: 503 });
      }),
    );
    const capture = vi.fn(() =>
      HttpResponse.json({
        templateId: OUTSIDE,
        operationId: WORKSPACE,
        writtenTargetItemIds: [OUTSIDE],
        fileTransferPending: false,
      }),
    );
    server.use(
      http.get(`${CORE}/api/v1/items/${DENTIST}`, () =>
        HttpResponse.json(item(DENTIST, TASKS, 'Synthetic note')),
      ),
      http.get(`${CORE}/api/v1/items/${TASKS}`, () =>
        HttpResponse.json(item(TASKS, ROOT, 'Tasks')),
      ),
      http.get(`${CORE}/api/v1/workspaces/${WORKSPACE}/items`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.get(`${CORE}/api/v1/workspaces/${WORKSPACE}/templates/capture-preview/${DENTIST}`, () =>
        HttpResponse.json({
          fingerprint: 'a'.repeat(64),
          captureFingerprint: 'b'.repeat(64),
          sourceTitle: 'Synthetic note',
          itemCount: 1,
        }),
      ),
      http.post('http://nix.eval.test:8100/templates/captures', capture),
      http.get(`${CORE}/api/v1/templates/${OUTSIDE}`, () =>
        HttpResponse.json({ title: 'Detail unavailable', status: 503 }, { status: 503 }),
      ),
    );
    const chatCase = chatCaseSchema.parse({
      id: 'uncertain-save',
      prompt: 'Capture the synthetic note.',
      templateSource: 'task-dentist',
      approvedOperations: ['save_as_template'],
    });
    const scoped = {
      ...fixture,
      templateSourceId: DENTIST,
      templates: new Map<string, TemplateSummary>(),
    };
    await expect(
      runChatCase(
        chatCase,
        1,
        { suite: 'chat', workspace: WORKSPACE, pet: PET, allowWrites: true },
        scoped,
        runner(),
      ),
    ).rejects.toThrow('Template capture did not return a confirmed result');
    expect(capture).toHaveBeenCalledOnce();
    expect(resets).toBe(1);
    expect(calls.some((call) => call.operation === 'interrupt')).toBe(true);
    // The failed local receipt contains no recoverable ID; no catalog sweep or write retry ran.
    expect(scoped.templates.size).toBe(0);
  });

  it('retains the source when template setup has an uncertain capture result', async () => {
    server.use(
      http.get(`${CORE}/api/v1/items/${DENTIST}`, () =>
        HttpResponse.json(item(DENTIST, TASKS, 'Synthetic note')),
      ),
      http.get(`${CORE}/api/v1/workspaces/${WORKSPACE}/items`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.get(`${CORE}/api/v1/workspaces/${WORKSPACE}/templates/capture-preview/${DENTIST}`, () =>
        HttpResponse.json({
          fingerprint: 'a'.repeat(64),
          captureFingerprint: 'b'.repeat(64),
          sourceTitle: 'Synthetic note',
          itemCount: 1,
        }),
      ),
      http.post('http://nix.eval.test:8100/templates/captures', () =>
        HttpResponse.json({ title: 'Uncertain', status: 503 }, { status: 503 }),
      ),
    );
    const teardown = vi.fn(() => Promise.resolve());
    const chatCase = chatCaseSchema.parse({
      id: 'uncertain-seed',
      prompt: 'Read the template.',
      templateSource: 'task-dentist',
    });
    await expect(
      runChatSuite(
        [chatCase],
        { suite: 'chat', workspace: WORKSPACE, pet: PET },
        { ...runner(), teardown },
      ),
    ).rejects.toThrow('fixture was left in place');
    expect(teardown).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'stops an unfinished turn before resetting or removing its fixture: settles=$0',
    async (settles) => {
      const tools = [
        toolCall('one', { operation: 'unsupported' }),
        toolCall('two', { operation: 'unsupported' }),
      ];
      const calls: string[] = [];
      let state = 'idle';
      let interrupted = false;
      let settlingReads = 0;
      server.use(
        http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          const operation = String(body.operation);
          calls.push(operation);
          if (operation === 'send') state = 'thinking';
          if (operation === 'tool_claim') {
            const tool = tools.find((entry) => entry.id === body.toolId);
            if (tool) {
              tool.status = 'claimed';
              tool.claimId = String(body.requestId);
            }
          }
          if (operation === 'tool_result') {
            const tool = tools.find((entry) => entry.id === body.toolId);
            if (tool) tool.status = 'failed';
          }
          if (operation === 'interrupt') interrupted = true;
          if (operation === 'read' && interrupted) {
            settlingReads += 1;
            if (settles && settlingReads >= 2) state = 'error';
          }
          if (operation === 'reset') {
            if (state === 'thinking')
              return HttpResponse.json(
                { title: 'Stop the running turn first', status: 409 },
                { status: 409 },
              );
            state = 'idle';
          }
          return HttpResponse.json(connection({ state, tools: interrupted ? [] : tools }));
        }),
      );
      const teardown = vi.fn(() => {
        expect(state).toBe('idle');
        return Promise.resolve();
      });
      const chatCase = chatCaseSchema.parse({
        id: 'stop-turn',
        prompt: 'Check.',
        tools: { max: 1 },
      });
      const result = runChatSuite(
        [chatCase],
        { suite: 'chat', workspace: WORKSPACE, pet: PET },
        { ...runner(), teardown },
      );
      if (settles) {
        const [score] = await result;
        expect(score?.outcome).toBe('tool_limit');
        expect(teardown).toHaveBeenCalledOnce();
        expect(calls.slice(-5)).toEqual(['interrupt', 'read', 'read', 'reset', 'history']);
      } else {
        await expect(result).rejects.toThrow('fixture was left in place');
        expect(teardown).not.toHaveBeenCalled();
        expect(calls.filter((entry) => entry === 'reset')).toHaveLength(1);
        expect(settlingReads).toBe(10);
      }
    },
  );

  it('scores a case that errors and goes on, deleting only the archives the run made', async () => {
    const OLD_ARCHIVE = '0f000000-0000-4000-8000-000000000001';
    const NEW_ARCHIVE = '0f000000-0000-4000-8000-000000000002';
    const deleted: unknown[] = [];
    let sends = 0;
    server.use(
      http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        if (body.operation === 'send' && (sends += 1) === 1)
          return HttpResponse.json(
            { title: 'Companion unavailable', status: 502 },
            { status: 502 },
          );
        if (body.operation === 'history')
          return HttpResponse.json(
            connection({
              history: [
                { id: OLD_ARCHIVE, title: 'Owner chat', createdAt: '2020-01-01T00:00:00Z' },
                { id: NEW_ARCHIVE, title: 'Eval', createdAt: new Date().toISOString() },
              ],
            }),
          );
        if (body.operation === 'delete_history') deleted.push(body.historyId);
        if (body.operation === 'read')
          return HttpResponse.json(
            connection({
              state: 'success',
              messages: [{ id: 'a', role: 'assistant', text: 'Hi.' }],
            }),
          );
        return HttpResponse.json(connection({ state: 'idle' }));
      }),
    );
    const cases = ['first', 'second'].map((id) => chatCaseSchema.parse({ id, prompt: 'Hello' }));
    const results = await runChatSuite(
      cases,
      { suite: 'chat', workspace: WORKSPACE, pet: PET },
      runner(),
    );
    expect(results.map((result) => [result.id, result.outcome])).toEqual([
      ['first', 'error'],
      ['second', 'done'],
    ]);
    expect(results[0]?.failures[0]).toMatch(/^error: /);
    expect(deleted).toEqual([NEW_ARCHIVE, NEW_ARCHIVE]);
  });

  it.each([
    { variant: 'correct', pass: true },
    { variant: 'wrong field', pass: false },
    { variant: 'wrong view', pass: false },
    { variant: 'wrong note', pass: false },
    { variant: 'duplicate', pass: false },
  ])('grades created child schema, views, note and count: $variant', async ({ variant, pass }) => {
    scriptedRuntime([], 'Created.');
    const child = item(DENTIST, TASKS, 'Created demo', { mood: 'Calm' });
    const field = {
      key: 'mood',
      label: 'Mood',
      type: variant === 'wrong field' ? 'number' : 'text',
      options: [],
      required: false,
    };
    server.use(
      http.get(`${CORE}/api/v1/workspaces/${WORKSPACE}/items`, ({ request }) =>
        HttpResponse.json({
          items:
            new URL(request.url).searchParams.get('parentId') === TASKS
              ? variant === 'duplicate'
                ? [child, { ...child, id: OUTSIDE }]
                : [child]
              : [],
          nextCursor: null,
        }),
      ),
      http.get(`${CORE}/api/v1/items/${DENTIST}`, () => HttpResponse.json(child)),
      http.get(`${CORE}/api/v1/items/${DENTIST}/schema`, () =>
        HttpResponse.json({ properties: [field], declared: [field], inherit: true }),
      ),
      http.get(`${CORE}/api/v1/items/${DENTIST}/views`, () =>
        HttpResponse.json({
          views: [
            {
              id: 'list-1',
              kind: 'list',
              name: 'Overview',
              columns: variant === 'wrong view' ? [] : ['title', 'mood'],
            },
          ],
          default: 'list-1',
          hideDocument: false,
          unrenderable: [],
        }),
      ),
      http.get('http://nix.eval.test:8100/documents/:itemId/updates', () =>
        HttpResponse.json({
          headSeq: '1',
          schemaVersion: 2,
          updates: [
            {
              seq: '1',
              update: bodyUpdate(variant === 'wrong note' ? 'Unrelated.' : 'A calm demo tour.'),
            },
          ],
          hasMore: false,
        }),
      ),
    );
    const chatCase = chatCaseSchema.parse({
      id: 'created-child',
      prompt: 'Verify the demo.',
      asserts: [
        {
          kind: 'child',
          parent: 'tasks',
          title: '^Created demo$',
          count: 1,
          values: { mood: 'Calm' },
          fields: [{ key: 'mood', equals: { type: 'text', inherited: false } }],
          views: [{ name: 'Overview', equals: { kind: 'list', columns: ['title', 'mood'] } }],
          noteContains: 'calm demo tour',
        },
      ],
    });
    const [result] = await runChatSuite(
      [chatCase],
      { suite: 'chat', workspace: WORKSPACE, pet: PET },
      runner(),
    );
    expect(result?.pass).toBe(pass);
    if (!pass) expect(result?.failures).toHaveLength(1);
  });

  it.each([false, true])(
    'independently verifies that a refused view was not saved: present=$0',
    async (present) => {
      scriptedRuntime([], 'Refused.');
      server.use(
        http.get(`${CORE}/api/v1/items/${TASKS}/views`, () =>
          HttpResponse.json({
            views: present ? [{ id: 'refused', kind: 'list', name: 'Too many' }] : [],
            default: present ? 'refused' : '',
            hideDocument: false,
            unrenderable: [],
          }),
        ),
      );
      const chatCase = chatCaseSchema.parse({
        id: 'absent-view',
        prompt: 'Check.',
        asserts: [{ kind: 'view', item: 'tasks', name: 'Too many', exists: false }],
      });
      const [result] = await runChatSuite(
        [chatCase],
        { suite: 'chat', workspace: WORKSPACE, pet: PET },
        runner(),
      );
      expect(result?.pass).toBe(!present);
    },
  );

  it('sends no conversation mode on any request or cleanup', async () => {
    const calls = scriptedRuntime(
      [toolCall('bad', { operation: 'create_note', title: 'Outside' })],
      'Cannot change that.',
    );
    const chatCase = chatCaseSchema.parse({
      id: 'design-route',
      prompt: 'Check.',
      tools: { require: ['create_note'] },
    });
    const [result] = await runChatSuite(
      [chatCase],
      { suite: 'chat', workspace: WORKSPACE, pet: PET },
      runner(),
    );
    expect(result?.pass).toBe(true);
    expect(calls.length).toBeGreaterThan(4);
    expect(calls.every((call) => call.mode === '')).toBe(true);
  });

  it('explicit fixture approvals require writes enabled and never cross the fixture boundary', async () => {
    server.use(
      http.get(`${CORE}/api/v1/items/${DENTIST}`, () =>
        HttpResponse.json(item(DENTIST, TASKS, 'Task')),
      ),
      http.get(`${CORE}/api/v1/items/${TASKS}`, () =>
        HttpResponse.json(item(TASKS, ROOT, 'Tasks')),
      ),
      http.get(`${CORE}/api/v1/items/${OUTSIDE}`, () =>
        HttpResponse.json(item(OUTSIDE, null, 'Outside')),
      ),
    );
    const session = runner().session;
    const inside = {
      ...toolCall('trash', { operation: 'trash_item', itemId: DENTIST }),
      status: 'pending' as const,
    };
    const outside = {
      ...toolCall('outside', { operation: 'trash_item', itemId: OUTSIDE }),
      status: 'pending' as const,
    };
    expect(
      await declineReason(
        session,
        fixture,
        inside,
        true,
        new Map(),
        false,
        undefined,
        undefined,
        undefined,
        ['trash_item'],
      ),
    ).toBeUndefined();
    expect(
      await declineReason(
        session,
        fixture,
        inside,
        false,
        new Map(),
        false,
        undefined,
        undefined,
        undefined,
        ['trash_item'],
      ),
    ).toBe('writes are not allowed in this run');
    expect(
      await declineReason(
        session,
        fixture,
        outside,
        true,
        new Map(),
        false,
        undefined,
        undefined,
        undefined,
        ['trash_item'],
      ),
    ).toBe('the target is outside the fixture');
    expect(
      await declineReason(
        session,
        fixture,
        inside,
        true,
        new Map(),
        true,
        undefined,
        undefined,
        undefined,
        ['trash_item'],
      ),
    ).toBe("earlier reads need the owner's review before changes");
    const move = {
      ...toolCall('move', { operation: 'move_item', itemId: DENTIST, parentId: OUTSIDE }),
      status: 'pending' as const,
    };
    expect(
      await declineReason(
        session,
        fixture,
        move,
        true,
        new Map(),
        false,
        undefined,
        undefined,
        undefined,
        ['move_item'],
      ),
    ).toBe('the target is outside the fixture');
  });

  it.each([
    { source: 'computed', properties: { total: -1 }, computed: { total: 42 }, pass: true },
    { source: 'computed', properties: { total: 42 }, computed: null, pass: false },
    { source: 'properties', properties: { total: 42 }, computed: { total: -1 }, pass: true },
  ] as const)('checks $source values without substituting another source', async (entry) => {
    scriptedRuntime([], 'Checked.');
    server.use(
      http.get(`${CORE}/api/v1/items/${DENTIST}`, () =>
        HttpResponse.json({
          ...item(DENTIST, TASKS, 'Call dentist', entry.properties),
          computed: entry.computed,
        }),
      ),
    );
    const chatCase = chatCaseSchema.parse({
      id: 'check-total',
      prompt: 'Check the total.',
      asserts: [
        { kind: 'value', item: 'task-dentist', key: 'total', source: entry.source, equals: 42 },
      ],
    });
    const [result] = await runChatSuite(
      [chatCase],
      { suite: 'chat', workspace: WORKSPACE, pet: PET },
      runner(),
    );
    expect(result?.pass).toBe(entry.pass);
  });

  it.each([
    { expression: '[hours] * 2', inherited: false, pass: true },
    { expression: '[hours] * 3', inherited: false, pass: false },
    { expression: '[hours] * 2', inherited: true, pass: false },
  ])(
    'proves computed field configuration and declaration: $expression, $inherited',
    async (entry) => {
      scriptedRuntime([], 'Checked.');
      const field = {
        key: 'total',
        label: 'Total',
        type: 'formula',
        options: [],
        required: false,
        expression: entry.expression,
        aggregate: null,
        source: null,
      };
      server.use(
        http.get(`${CORE}/api/v1/items/${TASKS}`, () =>
          HttpResponse.json(item(TASKS, ROOT, 'Tasks')),
        ),
        http.get(`${CORE}/api/v1/items/${TASKS}/schema`, () =>
          HttpResponse.json({
            properties: [field],
            declared: entry.inherited ? [] : [field],
            inherit: true,
          }),
        ),
        http.get(`${CORE}/api/v1/items/${TASKS}/views`, () =>
          HttpResponse.json({ views: [], default: '', hideDocument: false, unrenderable: [] }),
        ),
        http.get(`${CORE}/api/v1/workspaces/${WORKSPACE}/items`, () =>
          HttpResponse.json({ items: [], nextCursor: null }),
        ),
      );
      const chatCase = chatCaseSchema.parse({
        id: 'check-formula',
        prompt: 'Check the formula.',
        asserts: [
          {
            kind: 'field',
            item: 'tasks',
            key: 'total',
            equals: {
              type: 'formula',
              expression: '[hours] * 2',
              inherited: false,
              computed: true,
            },
          },
        ],
      });
      const [result] = await runChatSuite(
        [chatCase],
        { suite: 'chat', workspace: WORKSPACE, pet: PET },
        runner(),
      );
      expect(result?.pass).toBe(entry.pass);
      if (!entry.pass) expect(result?.failures.join(' ')).toContain('differs at');
    },
  );

  it('can prove a task remains incomplete with a falsy assertion', async () => {
    scriptedRuntime([], 'Checked.');
    server.use(
      http.get(`${CORE}/api/v1/items/${DENTIST}`, () =>
        HttpResponse.json(item(DENTIST, TASKS, 'Call dentist', { completion: false })),
      ),
    );
    const chatCase = chatCaseSchema.parse({
      id: 'check-open',
      prompt: 'Check.',
      asserts: [{ kind: 'value', item: 'task-dentist', key: 'completion', truthy: false }],
    });
    const [result] = await runChatSuite(
      [chatCase],
      { suite: 'chat', workspace: WORKSPACE, pet: PET },
      runner(),
    );
    expect(result?.pass).toBe(true);
  });

  it('substitutes relative dates in the fixture', () => {
    expect(substituteDates('{today} {today+3} {today-2}', '2026-10-08')).toBe(
      '2026-10-08 2026-10-11 2026-10-06',
    );
  });

  it('isolates seeded queries inside their fixture while retaining their rules, other views and defaults', async () => {
    const writes: Record<string, unknown>[] = [];
    server.use(
      http.get(`${CORE}/api/v1/items/${TASKS}`, () =>
        HttpResponse.json(item(TASKS, ROOT, 'Tasks')),
      ),
      http.get(`${CORE}/api/v1/items/${TASKS}/views`, () =>
        HttpResponse.json({
          views: [
            {
              id: 'open-1',
              name: 'Open work',
              kind: 'query',
              filters: [{ property: 'status', operator: 'equals', value: 'Done' }],
            },
            { id: 'board-1', name: 'Stages', kind: 'board', groupBy: 'status' },
          ],
          unrenderable: [],
          default: 'board-1',
          hideDocument: true,
        }),
      ),
      http.put(`${CORE}/api/v1/items/${TASKS}/views`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        writes.push(body);
        return HttpResponse.json({ ...body, unrenderable: [] });
      }),
    );
    await scopeFixtureQueryViews(runner().session, fixture, ['tasks']);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      default: 'board-1',
      hideDocument: true,
      views: [
        {
          id: 'open-1',
          filters: [
            { property: 'status', operator: 'equals', value: 'Done', any: null },
            { property: '$inside', operator: 'equals', value: TASKS, any: null },
          ],
        },
        { id: 'board-1', groupBy: 'status' },
      ],
    });
  });

  it('refuses query seeding outside the fixture and a scope that would exceed the condition budget', async () => {
    server.use(
      http.get(`${CORE}/api/v1/items/${OUTSIDE}`, () =>
        HttpResponse.json(item(OUTSIDE, null, 'Outside')),
      ),
    );
    await expect(
      scopeFixtureQueryViews(
        runner().session,
        { ...fixture, nodes: new Map([['outside', OUTSIDE]]) },
        ['outside'],
      ),
    ).rejects.toThrow('outside the seeded fixture');
    server.use(
      http.get(`${CORE}/api/v1/items/${TASKS}`, () =>
        HttpResponse.json(item(TASKS, ROOT, 'Tasks')),
      ),
      http.get(`${CORE}/api/v1/items/${TASKS}/views`, () =>
        HttpResponse.json({
          views: [
            {
              id: 'open-1',
              name: 'Open work',
              kind: 'query',
              filters: [
                {
                  any: Array.from({ length: 8 }, () => ({
                    property: 'status',
                    operator: 'equals',
                    value: 'Done',
                  })),
                },
              ],
            },
          ],
          unrenderable: [],
          default: 'open-1',
          hideDocument: false,
        }),
      ),
    );
    await expect(scopeFixtureQueryViews(runner().session, fixture, ['tasks'])).rejects.toThrow(
      'maximum 8 conditions',
    );
  });

  it('runs a read on its own, keeps a write declined without --allow-writes, and scores the answer', async () => {
    const calls = scriptedRuntime(
      [
        toolCall('t-1', { operation: 'list_items', parentId: TASKS }),
        toolCall('t-2', {
          operation: 'set_properties',
          itemId: DENTIST,
          propertiesJson: '{"completion":true}',
        }),
      ],
      'Pay rent and Call dentist are on the board.',
    );
    server.use(
      http.get(`${CORE}/api/v1/items/${TASKS}`, () =>
        HttpResponse.json(item(TASKS, ROOT, 'Tasks')),
      ),
      // nix_list_items reads the container's schema to key each row's values.
      http.get(`${CORE}/api/v1/items/${TASKS}/schema`, () =>
        HttpResponse.json({ properties: [], declared: [], inherit: true }),
      ),
      // The preview walks the destination's ancestors up to the fixture root.
      http.get(`${CORE}/api/v1/items/${ROOT}`, () => HttpResponse.json(item(ROOT, null, 'Home'))),
      // ...and the container's lock state, to report whether the read returned locked content.
      http.get(`${CORE}/api/v1/items/${TASKS}/lock`, () =>
        HttpResponse.json({
          locked: false,
          unlockedUntil: null,
          lockItemId: null,
          selfLocked: false,
        }),
      ),
      http.get(`${CORE}/api/v1/workspaces/${WORKSPACE}/items`, () =>
        HttpResponse.json({ items: [item(DENTIST, TASKS, 'Call dentist')], nextCursor: null }),
      ),
    );
    const chatCase = chatCaseSchema.parse({
      id: 'read-board',
      prompt: 'What is on {node:tasks}?',
      tools: { require: ['list_items|search'], forbid: ['create_note'], max: 6 },
      answer: 'Pay rent',
    });
    const [result] = await runChatSuite(
      [chatCase],
      { suite: 'chat', workspace: WORKSPACE, pet: PET },
      runner(),
    );
    expect(result).toMatchObject({ id: 'read-board', outcome: 'done', pass: true });
    expect(result?.tools).toEqual([
      expect.objectContaining({ operation: 'list_items', decision: 'ran', success: true }),
      expect.objectContaining({
        operation: 'set_properties',
        decision: 'declined',
        reason: 'writes are not allowed in this run',
      }),
    ]);
    expect(calls.find((call) => call.operation === 'send')).toMatchObject({
      text: 'What is on Tasks?',
      mode: '',
      workspaceAccess: true,
    });
    expect(calls.filter((call) => call.operation === 'reset')).toHaveLength(2);
  });

  it('declines a write outside the fixture and an always-ask write even with --allow-writes, and fails on the assertion', async () => {
    scriptedRuntime(
      [
        toolCall('t-1', { operation: 'rename_item', itemId: OUTSIDE, title: 'Elsewhere' }),
        toolCall('t-2', { operation: 'trash_item', itemId: DENTIST }),
      ],
      'Done.',
    );
    server.use(
      http.get(`${CORE}/api/v1/items/${OUTSIDE}`, () =>
        HttpResponse.json(item(OUTSIDE, null, 'Elsewhere')),
      ),
      http.get(`${CORE}/api/v1/items/${DENTIST}`, () =>
        HttpResponse.json(item(DENTIST, TASKS, 'Call dentist', { completion: false })),
      ),
    );
    const chatCase = chatCaseSchema.parse({
      id: 'complete-task',
      prompt: 'Mark it done.',
      tools: { require: ['set_properties'], forbid: ['trash_item'], max: 6 },
      asserts: [{ kind: 'value', item: 'task-dentist', key: 'completion', truthy: true }],
    });
    const [result] = await runChatSuite(
      [chatCase],
      { suite: 'chat', workspace: WORKSPACE, pet: PET, allowWrites: true },
      runner(),
    );
    expect(result?.tools).toEqual([
      expect.objectContaining({
        operation: 'rename_item',
        decision: 'declined',
        reason: 'the target is outside the fixture',
      }),
      expect.objectContaining({
        operation: 'trash_item',
        decision: 'declined',
        reason: 'trash_item always asks',
      }),
    ]);
    expect(result?.pass).toBe(false);
    expect(result?.failures).toEqual([
      'never attempted set_properties',
      'attempted forbidden trash_item',
      'task-dentist.completion is false, expected truthy',
    ]);
  });

  it('declines and fails every write attempted during a review, even with --allow-writes', async () => {
    scriptedRuntime(
      [
        toolCall('t-1', {
          operation: 'set_properties',
          itemId: DENTIST,
          propertiesJson: '{"completion":true}',
        }),
      ],
      'Reviewed.',
    );
    const chatCase = chatCaseSchema.parse({ id: 'review', prompt: 'Review only.', noWrites: true });
    const [result] = await runChatSuite(
      [chatCase],
      { suite: 'chat', workspace: WORKSPACE, pet: PET, allowWrites: true },
      runner(),
    );
    expect(result).toMatchObject({ pass: false, failures: ['review attempted a write'] });
    expect(result?.tools).toEqual([
      expect.objectContaining({
        operation: 'set_properties',
        decision: 'declined',
        reason: 'this case is a read-only review',
      }),
    ]);
  });

  it('sends disabled workspace access and declines attempted reads without touching the workspace', async () => {
    const calls = scriptedRuntime(
      [toolCall('t-1', { operation: 'read_item', itemId: DENTIST })],
      'I cannot inspect without access.',
    );
    const chatCase = chatCaseSchema.parse({
      id: 'access-off',
      prompt: 'Review it.',
      workspaceAccess: false,
      noWrites: true,
      answerChecks: { all: ['cannot', 'access'] },
    });
    const [result] = await runChatSuite(
      [chatCase],
      { suite: 'chat', workspace: WORKSPACE, pet: PET },
      runner(),
    );
    expect(calls.find((call) => call.operation === 'send')).toMatchObject({
      workspaceAccess: false,
    });
    expect(result?.tools).toEqual([
      expect.objectContaining({
        decision: 'declined',
        reason: 'workspace access is disabled for this case',
      }),
    ]);
    expect(result?.failures).toEqual(['attempted a tool with workspace access disabled']);
  });

  it('checks bounded answer signals and fixture evidence without retaining answer or tool content', async () => {
    const privateText = 'unrelated workspace secret';
    scriptedRuntime(
      [],
      `Call dentist has no Start date. PNG export is unavailable. ${privateText}`,
    );
    server.use(
      http.get(`${CORE}/api/v1/items/${DENTIST}`, () =>
        HttpResponse.json(item(DENTIST, TASKS, 'Call dentist')),
      ),
    );
    const chatCase = chatCaseSchema.parse({
      id: 'review-signals',
      prompt: 'Review.',
      noWrites: true,
      answerChecks: {
        all: ['Start date'],
        any: ['no Start date', 'missing date'],
        absent: ['export succeeded'],
        references: ['task-dentist'],
      },
      feedbackChecks: [
        { code: 'chart-image-export-unavailable', matches: 'PNG export is unavailable' },
      ],
    });
    const [result] = await runChatSuite(
      [chatCase],
      { suite: 'chat', workspace: WORKSPACE, pet: PET },
      runner(),
    );
    expect(result).toMatchObject({
      pass: true,
      answer: null,
      feedback: [{ code: 'chart-image-export-unavailable', source: 'answer' }],
    });
    expect(result?.answerLength).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain(privateText);
  });

  it('never records unrecognised operation text from a malformed tool call', async () => {
    scriptedRuntime([toolCall('t-1', { operation: 'private workspace text' })], 'Declined.');
    const chatCase = chatCaseSchema.parse({ id: 'malformed', prompt: 'Review.' });
    const [result] = await runChatSuite(
      [chatCase],
      { suite: 'chat', workspace: WORKSPACE, pet: PET },
      runner(),
    );
    expect(result?.tools).toEqual([
      expect.objectContaining({
        operation: 'unparseable',
        decision: 'declined',
        reason: 'unsupported request',
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('private workspace text');
  });

  it('fails a vague answer that omits its fixture evidence and required findings', async () => {
    scriptedRuntime([], 'Everything is fine; export succeeded.');
    server.use(
      http.get(`${CORE}/api/v1/items/${DENTIST}`, () =>
        HttpResponse.json(item(DENTIST, TASKS, 'Call dentist')),
      ),
    );
    const chatCase = chatCaseSchema.parse({
      id: 'review-signals',
      prompt: 'Review.',
      answerChecks: {
        all: ['Start date'],
        any: ['missing', 'undated'],
        absent: ['export succeeded'],
        references: ['task-dentist'],
      },
    });
    const [result] = await runChatSuite(
      [chatCase],
      { suite: 'chat', workspace: WORKSPACE, pet: PET },
      runner(),
    );
    expect(result?.failures).toEqual([
      'answer lacks required signal /Start date/',
      'answer lacks every alternative signal',
      'answer contains forbidden signal /export succeeded/',
      "answer does not reference fixture item 'task-dentist'",
    ]);
  });

  it('checks exact per-view settings with order-independent objects and significant array order', async () => {
    scriptedRuntime([], 'Verified.');
    server.use(
      http.get(`${CORE}/api/v1/items/${TASKS}/views`, () =>
        HttpResponse.json({
          views: [
            {
              id: 'board-1',
              name: 'Stages',
              kind: 'board',
              dateProperty: null,
              groupBy: 'status',
              groupOrder: ['To do', 'Doing', 'Done'],
              filters: [{ property: 'status', operator: 'equals', value: 'Doing' }],
            },
          ],
          unrenderable: [],
          default: 'board-1',
          hideDocument: false,
        }),
      ),
    );
    const chatCase = chatCaseSchema.parse({
      id: 'saved-view',
      prompt: 'Verify.',
      asserts: [
        {
          kind: 'view',
          item: 'tasks',
          name: 'Stages',
          equals: {
            groupBy: 'status',
            groupOrder: ['To do', 'Doing', 'Done'],
            filters: [{ value: 'Doing', operator: 'equals', property: 'status', any: null }],
          },
        },
      ],
    });
    const [passed] = await runChatSuite(
      [chatCase],
      { suite: 'chat', workspace: WORKSPACE, pet: PET },
      runner(),
    );
    expect(passed?.failures).toEqual([]);
    expect(passed?.pass).toBe(true);
    scriptedRuntime([], 'Verified.');
    const reordered = chatCaseSchema.parse({
      ...chatCase,
      asserts: [
        {
          kind: 'view',
          item: 'tasks',
          name: 'Stages',
          equals: { groupBy: 'team', groupOrder: ['Doing', 'To do', 'Done'] },
        },
      ],
    });
    const [failed] = await runChatSuite(
      [reordered],
      { suite: 'chat', workspace: WORKSPACE, pet: PET },
      runner(),
    );
    expect(failed?.failures).toEqual(["tasks view 'Stages' differs at groupBy, groupOrder"]);
  });

  it('reports failed operation names without retaining private error output, and requires successful evidence reads', async () => {
    scriptedRuntime(
      [toolCall('t-1', { operation: 'search', query: 'Tasks' })],
      'I could not search.',
    );
    server.use(
      http.get(`${CORE}/api/v1/search`, () =>
        HttpResponse.json({ title: 'private failure detail', status: 500 }, { status: 500 }),
      ),
    );
    const chatCase = chatCaseSchema.parse({
      id: 'failed-read',
      prompt: 'Review.',
      tools: { require: ['search'], requireSuccessful: ['search'] },
    });
    const [result] = await runChatSuite(
      [chatCase],
      { suite: 'chat', workspace: WORKSPACE, pet: PET },
      runner(),
    );
    expect(result?.failures).toEqual(['never completed search']);
    expect(result?.feedback).toEqual([
      { code: 'tool-failed', source: 'tool', operation: 'search' },
    ]);
    expect(JSON.stringify(result)).not.toContain('private failure detail');
  });

  describe('the same holds as the web card', () => {
    const session = () =>
      openSession({ profile: { apiUrl: CORE, token: 'pat' }, bearerToken: 'session' });
    const field = (key: string, type: string) => ({
      key,
      label: key,
      type,
      options: [],
      required: false,
      expression: null,
      aggregate: null,
      source: null,
    });
    /** Ports whose Core answers the reads a complete_task preview makes. */
    function taskPorts(repeating: boolean): CompanionPorts {
      const today = '2026-10-08';
      const query = vi.fn((endpoint: { operation: string }) =>
        Promise.resolve(
          endpoint.operation === 'schema.get'
            ? {
                properties: [field('due_date', 'due_date'), field('completion', 'completion')],
                declared: [],
                inherit: true,
              }
            : endpoint.operation === 'locks.get'
              ? { locked: false, unlockedUntil: null, lockItemId: null, selfLocked: false }
              : endpoint.operation === 'workspaceCalendar.get'
                ? {
                    workspaceId: WORKSPACE,
                    from: today,
                    to: today,
                    entries: repeating
                      ? [
                          {
                            itemId: DENTIST,
                            title: 'Call dentist',
                            containerId: TASKS,
                            containerTitle: 'Tasks',
                            dateProperty: 'due_date',
                            value: today,
                            kind: 'date',
                            generated: true,
                            completed: false,
                            endProperty: null,
                            endValue: null,
                          },
                        ]
                      : [],
                    unplaceable: [],
                    entryLimit: 2000,
                    entriesTruncated: false,
                    seriesTruncated: false,
                  }
                : endpoint.operation === 'items.get'
                  ? item(DENTIST, null, 'Call dentist', {
                      due_date: '2026-09-01',
                      completion: false,
                    })
                  : undefined,
        ),
      );
      const core = { query, execute: vi.fn(), paginate: vi.fn() };
      return {
        core,
        collab: core,
        bodies: { read: vi.fn(), append: vi.fn() },
        clock: {
          today: () => today,
          timeZone: () => 'UTC',
          now: () => new Date(`${today}T09:00:00Z`),
        },
        ids: { uuid: () => '00000001-0000-4000-8000-000000000000' },
      } as unknown as CompanionPorts;
    }
    function inFixture() {
      server.use(
        http.get(`${CORE}/api/v1/items/${DENTIST}`, () =>
          HttpResponse.json(item(DENTIST, TASKS, 'Call dentist')),
        ),
        http.get(`${CORE}/api/v1/items/${TASKS}`, () =>
          HttpResponse.json(item(TASKS, ROOT, 'Tasks')),
        ),
      );
    }

    it('allows only locally captured template identities and fixture-contained applications', async () => {
      inFixture();
      const captured: TemplateSummary = {
        id: DENTIST,
        workspaceId: WORKSPACE,
        title: 'Synthetic template',
        description: null,
        origin: 'user',
        revision: 1,
        includeBody: true,
        includeChildren: false,
        fieldCount: 0,
        viewCount: 0,
        childCount: 0,
        viewKinds: [],
        capabilities: { canEdit: true, canDelete: true, canExport: true, canApply: true },
        updatedAt: '2026-10-09T00:00:00.000Z',
      };
      const scoped = { ...fixture, templates: new Map([[DENTIST, captured]]) };
      const call = (operation: string, itemId: string, parentId = '') => ({
        ...toolCall('template', { operation, itemId, parentId, title: 'Copy', specJson: '{}' }),
        status: 'pending' as const,
      });
      expect(
        await declineReason(session(), scoped, call('read_template', OUTSIDE), true, new Map()),
      ).toBe('the template was not captured by this fixture');
      expect(
        await declineReason(session(), scoped, call('read_template', DENTIST), false, new Map()),
      ).toBeUndefined();
      expect(
        await declineReason(
          session(),
          scoped,
          call('apply_template', OUTSIDE, TASKS),
          true,
          new Map(),
        ),
      ).toBe('the template was not captured by this fixture');
      expect(
        await declineReason(
          session(),
          scoped,
          call('apply_template', DENTIST, TASKS),
          true,
          new Map(),
        ),
      ).toBeUndefined();
      expect(
        await declineReason(session(), scoped, call('apply_template', DENTIST), true, new Map()),
      ).toBe('the target is the workspace root, outside the fixture');
    });

    it.each([1, 2])(
      'requires a full preview fence for the approved single-note capture: count=$0',
      async (itemCount) => {
        inFixture();
        const base = taskPorts(false);
        const query = vi.fn(() =>
          Promise.resolve({
            fingerprint: 'a'.repeat(64),
            captureFingerprint: 'b'.repeat(64),
            sourceTitle: 'Synthetic source',
            itemCount,
          }),
        );
        const ports = { ...base, core: { ...base.core, query } } as unknown as CompanionPorts;
        const approvedSource = { ...fixture, templateSourceId: DENTIST };
        const capture = {
          ...toolCall('save', {
            operation: 'save_as_template',
            itemId: DENTIST,
            title: 'Saved',
            specJson: '{"includeSamples":true}',
          }),
          status: 'pending' as const,
        };
        const fence = vi.fn();
        const reason = await declineReason(
          session(),
          approvedSource,
          capture,
          true,
          new Map(),
          false,
          ports,
          WORKSPACE,
          fence,
          ['save_as_template'],
        );
        expect(reason).toBe(
          itemCount === 1
            ? undefined
            : 'the approved template source must remain a single synthetic note',
        );
        if (itemCount === 1) expect(fence).toHaveBeenCalledWith('a'.repeat(64));
        else expect(fence).not.toHaveBeenCalled();
        expect(
          await declineReason(
            session(),
            approvedSource,
            capture,
            true,
            new Map(),
            true,
            ports,
            WORKSPACE,
            fence,
            ['save_as_template'],
          ),
        ).toBe("earlier reads need the owner's review before changes");
        expect(
          await declineReason(
            session(),
            fixture,
            capture,
            true,
            new Map(),
            false,
            ports,
            WORKSPACE,
            fence,
            ['save_as_template'],
          ),
        ).toBe('only the approved synthetic fixture note may be captured');
        const excludesSamples = {
          ...capture,
          arguments: toolCall('save', {
            operation: 'save_as_template',
            itemId: DENTIST,
            title: 'Saved',
            specJson: '{}',
          }).arguments,
        };
        expect(
          await declineReason(
            session(),
            approvedSource,
            excludesSamples,
            true,
            new Map(),
            false,
            ports,
            WORKSPACE,
            fence,
            ['save_as_template'],
          ),
        ).toBe('the fixture capture must include samples and have no initialization rules');
      },
    );
    const pending = (tool: ReturnType<typeof toolCall>) => ({
      ...tool,
      status: 'pending' as const,
    });
    const completeTask = pending(
      toolCall('t-1', {
        operation: 'complete_task',
        itemId: DENTIST,
        specJson: '{"completed":true}',
      }),
    );

    it('declines every write once the conversation has read locked content', async () => {
      inFixture();
      const write = pending(
        toolCall('t-1', {
          operation: 'set_properties',
          itemId: DENTIST,
          propertiesJson: '{"completion":true}',
        }),
      );
      expect(await declineReason(session(), fixture, write, true, new Map(), true)).toBe(
        "earlier reads need the owner's review before changes",
      );
      expect(
        await declineReason(session(), fixture, write, true, new Map(), false),
      ).toBeUndefined();
    });

    it('requires an explicit fixture approval and a valid fingerprint preview for update_view', async () => {
      inFixture();
      const edit = pending(
        toolCall('t-1', {
          operation: 'update_view',
          itemId: TASKS,
          specJson: '{"viewId":"board-1","patch":{"groupBy":"status"}}',
        }),
      );
      const view = viewConfigurationSchema.parse({
        id: 'board-1',
        name: 'Stages',
        kind: 'board',
        groupBy: 'team',
      });
      const status = { ...field('status', 'select'), options: ['To do', 'Doing', 'Done'] };
      const team = { ...field('team', 'select'), options: ['Studio', 'Engineering'] };
      let viewVersion: string | null = 'a'.repeat(64);
      const base = taskPorts(false);
      const query = vi.fn((endpoint: { operation: string; path: string }) =>
        Promise.resolve(
          endpoint.operation === 'schema.get'
            ? { properties: [status, team], declared: [status, team], inherit: true }
            : endpoint.operation === 'views.getConfigurations'
              ? {
                  views: [view],
                  unrenderable: [],
                  default: view.id,
                  hideDocument: false,
                  version: viewVersion,
                }
              : endpoint.operation === 'items.get'
                ? endpoint.path.includes(TASKS)
                  ? item(TASKS, ROOT, 'Tasks')
                  : item(ROOT, null, 'Home')
                : undefined,
        ),
      );
      const ports = { ...base, core: { ...base.core, query } } as unknown as CompanionPorts;
      expect(
        await declineReason(session(), fixture, edit, true, new Map(), false, ports, WORKSPACE),
      ).toBe('update_view always asks');
      expect(
        await declineReason(
          session(),
          fixture,
          edit,
          false,
          new Map(),
          false,
          ports,
          WORKSPACE,
          undefined,
          ['update_view'],
        ),
      ).toBe('writes are not allowed in this run');
      expect(
        await declineReason(
          session(),
          fixture,
          edit,
          true,
          new Map(),
          false,
          undefined,
          WORKSPACE,
          undefined,
          ['update_view'],
        ),
      ).toBe('the view edit has no preview');
      expect(
        await declineReason(
          session(),
          fixture,
          edit,
          true,
          new Map(),
          true,
          ports,
          WORKSPACE,
          undefined,
          ['update_view'],
        ),
      ).toBe("earlier reads need the owner's review before changes");
      const onPreview = vi.fn();
      expect(
        await declineReason(
          session(),
          fixture,
          edit,
          true,
          new Map(),
          false,
          ports,
          WORKSPACE,
          onPreview,
          ['update_view'],
        ),
      ).toBeUndefined();
      expect(onPreview).toHaveBeenCalledWith(expect.any(String));
      expect(onPreview.mock.calls[0]?.[0]).toContain('board-1');
      viewVersion = null;
      expect(
        await declineReason(
          session(),
          fixture,
          edit,
          true,
          new Map(),
          false,
          ports,
          WORKSPACE,
          onPreview,
          ['update_view'],
        ),
      ).toBe('the preview has problems');
    });

    it('declines completing an occurrence of a repeating task, and any completion without a preview', async () => {
      inFixture();
      expect(
        await declineReason(
          session(),
          fixture,
          completeTask,
          true,
          new Map(),
          false,
          taskPorts(true),
          WORKSPACE,
        ),
      ).toBe("completing a repeating task's occurrence cannot be undone");
      expect(await declineReason(session(), fixture, completeTask, true, new Map(), false)).toBe(
        'the task may repeat and there is no preview',
      );
      expect(
        await declineReason(
          session(),
          fixture,
          completeTask,
          true,
          new Map(),
          false,
          taskPorts(false),
          WORKSPACE,
        ),
      ).toBeUndefined();
    });
    describe.each(['replace_section', 'replace_passage'] as const)(
      '%s preview holds',
      (operation) => {
        const edit = pending(
          toolCall('t-1', { operation, itemId: DENTIST, query: 'old', markdown: 'new' }),
        );
        const plan: BodyEditPlan = {
          scope: operation === 'replace_section' ? 'section' : 'paragraph',
          before: 'old',
          after: 'new',
          blocksRemoved: 1,
          blocksAdded: 1,
          losses: [],
          markdownChanges: EMPTY_MARKDOWN_IMPORT_SCAN,
          fingerprint: 'checked-body',
        };
        function bodyPorts(value: BodyEditPlan = plan): CompanionPorts {
          const base = taskPorts(false);
          return {
            ...base,
            bodies: { ...base.bodies, planEdit: vi.fn().mockResolvedValue(value) },
          };
        }

        it('declines formatting loss and a link formed with the existing note text', async () => {
          inFixture();
          expect(
            await declineReason(
              session(),
              fixture,
              edit,
              true,
              new Map(),
              false,
              bodyPorts({ ...plan, losses: [{ kind: 'alignment-dropped', detail: '' }] }),
              WORKSPACE,
            ),
          ).toBe('the body edit removes formatting');
          const joining = pending(
            toolCall('t-1', {
              operation,
              itemId: DENTIST,
              query: 'old',
              markdown: 's://other.test',
            }),
          );
          expect(
            await declineReason(
              session(),
              fixture,
              joining,
              true,
              new Map(),
              false,
              bodyPorts({ ...plan, before: 'httpold', after: 'https://other.test' }),
              WORKSPACE,
            ),
          ).toBe('the text links to another host');
        });

        it('declines a missing, failed or refused preview', async () => {
          inFixture();
          expect(await declineReason(session(), fixture, edit, true, new Map())).toBe(
            'the body edit has no preview',
          );
          const base = bodyPorts();
          const planEdit = vi.fn().mockRejectedValueOnce(new Error('offline'));
          const ports = { ...base, bodies: { ...base.bodies, planEdit } };
          expect(
            await declineReason(session(), fixture, edit, true, new Map(), false, ports, WORKSPACE),
          ).toBe('the body edit preview could not be loaded');
          planEdit.mockRejectedValueOnce(new WorkspaceToolRefusal('Passage not found.'));
          expect(
            await declineReason(session(), fixture, edit, true, new Map(), false, ports, WORKSPACE),
          ).toBe('the preview has problems');
        });

        it('allows a clean preview and retains its fingerprint for execution', async () => {
          inFixture();
          const onPreview = vi.fn();
          expect(
            await declineReason(
              session(),
              fixture,
              edit,
              true,
              new Map(),
              false,
              bodyPorts(),
              WORKSPACE,
              onPreview,
            ),
          ).toBeUndefined();
          expect(onPreview).toHaveBeenCalledWith(plan.fingerprint);
        });
      },
    );
  });

  it('stops at the tool budget and reports it', async () => {
    scriptedRuntime(
      [
        toolCall('t-1', { operation: 'search', query: 'a' }),
        toolCall('t-2', { operation: 'search', query: 'b' }),
      ],
      'never reached',
    );
    server.use(
      http.get(`${CORE}/api/v1/search`, () => HttpResponse.json({ results: [], truncated: false })),
    );
    const chatCase = chatCaseSchema.parse({ id: 'budget', prompt: 'x', tools: { max: 1 } });
    const [result] = await runChatSuite(
      [chatCase],
      { suite: 'chat', workspace: WORKSPACE, pet: PET },
      runner(),
    );
    expect(result).toMatchObject({ outcome: 'tool_limit', pass: false });
    expect(result?.failures).toContain('outcome tool_limit');
  });

  describe('context and citations', () => {
    const OTHER_WORKSPACE = '99999999-9999-4999-8999-999999999999';
    const INVENTED = '88888888-8888-4888-8888-888888888888';
    const link = (workspace: string, id: string) => `/w/${workspace}?item=${id}`;

    async function answerWith(answer: string, extra: Record<string, unknown> = {}) {
      const calls = scriptedRuntime([], answer);
      server.use(
        http.get(`${CORE}/api/v1/items/${TASKS}`, () =>
          HttpResponse.json(item(TASKS, ROOT, 'Tasks')),
        ),
        http.get(`${CORE}/api/v1/items/${DENTIST}`, () =>
          HttpResponse.json(item(DENTIST, TASKS, 'Call dentist')),
        ),
        http.get(`${CORE}/api/v1/items/${INVENTED}`, () =>
          HttpResponse.json({ title: 'Not found', status: 404 }, { status: 404 }),
        ),
      );
      const chatCase = chatCaseSchema.parse({
        id: 'context-case',
        prompt: 'What is due?',
        noWrites: true,
        ...extra,
      });
      const [result] = await runChatSuite(
        [chatCase],
        { suite: 'chat', workspace: WORKSPACE, pet: PET },
        runner(),
      );
      return { result, calls };
    }

    it('sends the open note as itemId, and nothing when the case names none', async () => {
      const open = await answerWith('Fine.', { currentItem: 'tasks' });
      expect(open.calls.find((call) => call.operation === 'send')).toMatchObject({ itemId: TASKS });
      const none = await answerWith('Fine.');
      expect(none.calls.find((call) => call.operation === 'send')).not.toHaveProperty('itemId');
    });

    it('passes a cited fixture item and counts its link as valid', async () => {
      const { result } = await answerWith(`Due. Sources: ${link(WORKSPACE, DENTIST)}`, {
        answerChecks: { cites: ['task-dentist'] },
      });
      expect(result).toMatchObject({ pass: true, citations: { valid: 1, invalid: 0 } });
    });

    it('fails a case whose answer does not link the item it should cite', async () => {
      const { result } = await answerWith('Due: Call dentist.', {
        answerChecks: { cites: ['task-dentist'] },
      });
      expect(result?.pass).toBe(false);
      expect(result?.failures).toContain("answer does not link fixture item 'task-dentist'");
      expect(result?.citations).toEqual({ valid: 0, invalid: 0 });
    });

    it('fails every case that links an invented item or an item in another workspace', async () => {
      const invented = await answerWith(`See ${link(WORKSPACE, INVENTED)}`);
      expect(invented.result).toMatchObject({ pass: false, citations: { valid: 0, invalid: 1 } });
      expect(invented.result?.failures).toContain(
        'answer links an item that is not readable or does not exist',
      );
      const foreign = await answerWith(`See ${link(OTHER_WORKSPACE, DENTIST)}`);
      expect(foreign.result).toMatchObject({ pass: false, citations: { valid: 0, invalid: 1 } });
    });

    it('selects a group of cases by a trailing star', async () => {
      const group = await readChatCases('context-*');
      expect(group.map((entry) => entry.id)).toEqual([
        'context-current-note',
        'context-current-irrelevant',
        'context-search',
        'context-backlinks',
        'context-multi-step',
      ]);
      expect(await readChatCases('overdue')).toHaveLength(1);
      await expect(readChatCases('nothing-*')).rejects.toThrow('Unknown chat case');
    });
  });

  describe('fixture links', () => {
    const MEETING = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const HUB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const linked: ChatFixture = {
      rootId: ROOT,
      nodes: new Map([
        ['meeting-note', MEETING],
        ['hub-note', HUB],
      ]),
    };

    function backlinks(sourceId: string | null) {
      let reads = 0;
      server.use(
        http.get(`${CORE}/api/v1/items/${MEETING}/backlinks`, () => {
          reads += 1;
          const rows =
            sourceId === null || reads < 3
              ? []
              : [
                  {
                    source: {
                      id: sourceId,
                      workspaceId: WORKSPACE,
                      type: 'note',
                      title: 'Project hub',
                      parentId: ROOT,
                      updatedAt: '2026-10-08T00:00:00.000Z',
                    },
                    occurrences: 1,
                  },
                ];
          return HttpResponse.json({ backlinks: rows, limit: 50, truncated: false });
        }),
      );
      return () => reads;
    }

    it('links the hub to the meeting note and waits until the backlink is indexed', async () => {
      const reads = backlinks(HUB);
      const append = vi.fn(() => Promise.resolve({}));
      const ports = { bodies: { append } } as unknown as CompanionPorts;

      await seedFixtureLinks(ports, runner().session, linked, () => Promise.resolve());

      expect(append).toHaveBeenCalledWith(
        HUB,
        `[Planning meeting](nix://item/${MEETING})`,
        expect.any(AbortSignal),
      );
      expect(reads()).toBe(3);
    });

    it('fails the build when the backlink never appears', async () => {
      const reads = backlinks(null);
      const ports = { bodies: { append: () => Promise.resolve({}) } } as unknown as CompanionPorts;

      await expect(
        seedFixtureLinks(ports, runner().session, linked, () => Promise.resolve()),
      ).rejects.toThrow('not indexed as a backlink');
      expect(reads()).toBe(5);
    });
  });
});
