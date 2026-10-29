import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWorkspaceMcpServer } from './mcp.ts';
import { openSession, type FetchImpl } from './session.ts';

const API = 'http://nix.test';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('nixctl mcp workspace tools', () => {
  it('publishes the workspace administration surface without credential arguments', async () => {
    const connected = await connect('owner', async () => unexpectedRequest());
    try {
      const tools = await connected.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        'begin_template_draft',
        'get_template_draft',
        'update_template_draft',
        'update_template_draft_item',
        'save_template_draft',
        'discard_template_draft',
        'list_workspaces',
        'create_workspace',
        'rename_workspace',
        'set_workspace_sharing',
        'list_workspace_invitations',
        'list_workspace_invitees',
        'invite_workspace_member',
        'accept_workspace_invitation',
        'decline_workspace_invitation',
        'revoke_workspace_invitation',
        'get_operation',
        'cancel_template_archive_import',
        'list_workspace_members',
        'read_finance',
        'set_finance_settings',
        'read_finance_accounts',
        'create_finance_account',
        'set_finance_account',
        'finance_loan',
        'create_finance_line',
        'set_finance_line',
        'finance_dashboard',
        'finance_budget',
        'set_finance_actual',
        'delete_finance_transaction',
        'add_finance_transaction',
        'list_finance_transactions',
        'set_finance_transaction',
        'post_finance_scheduled',
        'set_finance_month',
        'finance_cashflow',
        'finance_month',
        'import_finance_statement',
        'set_habit',
        'set_habit_status',
        'list_comments',
        'add_comment',
        'reply_comment',
        'resolve_comment',
        'read_habit',
        'check_in_habit',
        'undo_habit_check_in',
        'change_workspace_member_role',
        'remove_workspace_member',
        'list_workspace_assignable_principals',
        'leave_workspace',
        'import_document',
        'get_document_import',
        'commit_document_import',
        'cancel_document_import',
        'upload_file',
        'replace_file',
        'list_file_versions',
        'download_file',
        'list_templates',
        'get_template',
        'capture_template',
        'preflight_template_application',
        'apply_template',
        'set_template_initialization',
        'preview_template_archive_import',
        'get_template_archive_import',
        'commit_template_archive_import',
        'export_template_archive',
        'resume_template_file_copy',
        'pet_runtime',
        'pet_tool_run',
        'structure_read',
        'blueprint_validate',
        'blueprint_describe',
        'blueprint_build',
        'list_notifications',
        'mark_notification_read',
        'mark_all_notifications_read',
        'get_notification_preferences',
        'set_notification_preferences',
        'set_reminder',
        'clear_reminder',
        'set_item_protection',
        'list_calendar_links',
        'sync_calendar_link',
        'calendar_link_log',
        'unlink_calendar',
        'list_automations',
        'get_automation',
        'create_automation',
        'update_automation',
        'set_automation_enabled',
        'delete_automation',
        'list_automation_runs',
        'run_automation',
        'test_automation',
        'list_items',
        'get_item',
        'create_item',
        'search_items',
        'read_note',
        'write_note',
        'create_chat_note',
        'import_chat_note',
        'get_chat_note',
        'read_chat_messages',
        'send_chat_message',
        'watch_chat_note',
        'cancel_chat_turn',
        'configure_chat_note',
        'set_chat_sources',
      ]);
      expect(JSON.stringify(tools)).not.toContain('token');
      expect(JSON.stringify(tools)).not.toContain('authorization');
    } finally {
      await connected.close();
    }
  });

  it('searches the people directory and preserves invitation eligibility in the result', async () => {
    const fetchImpl: FetchImpl = (input) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/public/v1/auth/token')) {
        return Promise.resolve(
          Response.json({
            accessToken: 'jwt-owner',
            tokenType: 'Bearer',
            expiresInSeconds: 600,
          }),
        );
      }
      expect(url.pathname).toBe(`/api/v1/workspaces/${WORKSPACE}/invitees`);
      expect(url.searchParams.get('query')).toBe('Ada');
      expect(url.searchParams.get('cursor')).toBe('next');
      return Promise.resolve(
        Response.json({
          items: [
            {
              principalId: WORKSPACE,
              displayName: 'Ada',
              email: null,
              canInvite: false,
              cannotInviteReason: 'email_missing',
            },
          ],
          nextCursor: null,
        }),
      );
    };
    vi.stubGlobal('fetch', fetchImpl);
    const connected = await connect('owner', fetchImpl);
    try {
      const result = await connected.client.callTool({
        name: 'list_workspace_invitees',
        arguments: { workspaceId: WORKSPACE, query: ' Ada ', cursor: 'next' },
      });
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result.content)).toContain('email_missing');
    } finally {
      await connected.close();
    }
  });

  it('requires explicit confirmation before a blueprint build reaches the API', async () => {
    const connected = await connect('owner', async () => unexpectedRequest());
    try {
      const result = await connected.client.callTool({
        name: 'blueprint_build',
        arguments: {
          specJson: JSON.stringify({
            version: 1,
            title: 'Draft',
            summary: '',
            root: { id: 'root', title: 'Draft' },
          }),
          workspaceId: WORKSPACE,
          confirm: false,
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('confirm: true');
    } finally {
      await connected.close();
    }
  });

  it('routes finance setup, ledger and report tools through the generated API client', async () => {
    const rootId = '11111111-1111-4111-8111-111111111111';
    const accountId = '33333333-3333-4333-8333-333333333333';
    const lineId = '44444444-4444-4444-8444-444444444444';
    const transactionId = '55555555-5555-4555-8555-555555555555';
    const calls: { method: string; path: string; query: string; body: unknown }[] = [];
    const responseFor = (path: string, method: string): Record<string, unknown> => {
      if (path.endsWith('/finance')) {
        return {
          itemId: rootId,
          settings: {
            currency: 'GBP',
            startMonth: '2026-08',
            endMonth: '2026-09',
            horizonMonths: 2,
            openingCash: 100,
            emergencyFundMonths: 3,
            timezone: 'Europe/London',
          },
          containers: {
            accounts: '66666666-6666-4666-8666-666666666666',
            lines: '77777777-7777-4777-8777-777777777777',
            transactions: '88888888-8888-4888-8888-888888888888',
          },
          accounts: [],
          lines: [],
          closedMonths: [],
          currentMonth: '2026-08',
          transactionCount: 0,
          problems: [],
        };
      }
      if (path.endsWith('/accounts') && method === 'GET') {
        return { itemId: rootId, month: '2026-08', accounts: [] };
      }
      if (path.endsWith('/accounts') && method !== 'GET') {
        return {
          id: accountId,
          name: 'Current',
          type: 'current',
          limit: null,
          openingBalance: 100,
          settlesFrom: null,
          apr: null,
          payment: null,
          overpayment: null,
          target: null,
          archived: false,
        };
      }
      if (path.includes('/accounts/')) {
        if (path.endsWith('/loan')) {
          const summary = {
            opening: 100,
            apr: 0.05,
            payment: 10,
            overpayment: 0,
            monthsToClear: 10,
            totalInterest: 1,
            totalPaid: 101,
            cleared: false,
            clearedIn: null,
            balanceAfterMonth: 90,
          };
          return {
            accountId,
            name: 'Loan',
            baseline: summary,
            alternative: summary,
            monthsSaved: 0,
            interestSaved: 0,
            months: [],
          };
        }
        if (path.includes(`/${accountId}`)) {
          return {
            id: accountId,
            name: 'Current',
            type: 'current',
            limit: null,
            openingBalance: 100,
            settlesFrom: null,
            apr: null,
            payment: null,
            overpayment: null,
            target: null,
            archived: false,
          };
        }
      }
      if (path.endsWith('/lines') || path.includes(`/lines/${lineId}`)) {
        return {
          id: lineId,
          name: 'Groceries',
          section: 'Living',
          flow: 'expense',
          accountId,
          amount: 300,
          overrides: {},
          scheduled: false,
          dueDay: null,
          loanAccount: null,
          archived: false,
          position: 1,
        };
      }
      if (path.endsWith('/transactions') || path.includes(`/transactions/${transactionId}`)) {
        if (path.includes(`/${transactionId}`)) {
          return {
            id: transactionId,
            description: 'Market',
            date: '2026-08-12',
            amount: -12.4,
            accountId,
            lineId,
            source: 'manual',
            postedFor: null,
            importKey: null,
            cleared: true,
          };
        }
        return { transactions: [], total: 0, truncated: false };
      }
      if (path.endsWith('/cashflow')) {
        return {
          itemId: rootId,
          openingBank: 100,
          openingCardOwed: 0,
          openingNetPosition: 100,
          emergencyTarget: 0,
          emergencyBasisMonth: '2026-08',
          bufferMetIn: null,
          months: [],
        };
      }
      if (path.endsWith('/months/2026-08')) {
        return {
          month: '2026-08',
          closed: false,
          scheduledPosted: 0,
          scheduledUnposted: 0,
          unassignedTransactions: 0,
          unassignedOutflow: 0,
          overPlan: [],
          plan: { income: 0, paidThisMonth: 0, cardSpend: 0, outgoings: 0, net: 0 },
          actual: { income: 0, paidThisMonth: 0, cardSpend: 0, outgoings: 0, net: 0 },
        };
      }
      if (path.endsWith('/import')) {
        return {
          rows: 0,
          readable: 0,
          created: 0,
          duplicates: 0,
          matched: 0,
          unreadable: 0,
          committed: false,
          preview: [],
          problem: null,
        };
      }
      throw new Error(`Unexpected finance route: ${path}`);
    };
    const fetchImpl: FetchImpl = (url, init) => {
      if (url.endsWith('/public/v1/auth/token')) {
        return Promise.resolve(
          Response.json({ accessToken: 'jwt-owner', tokenType: 'Bearer', expiresInSeconds: 600 }),
        );
      }
      const parsed = new URL(url);
      calls.push({
        method: init?.method ?? 'GET',
        path: parsed.pathname,
        query: parsed.search,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      return Promise.resolve(Response.json(responseFor(parsed.pathname, init?.method ?? 'GET')));
    };
    vi.stubGlobal('fetch', fetchImpl);
    const connected = await connect('owner', fetchImpl);
    try {
      const invoke = (name: string, args: Record<string, unknown>) =>
        connected.client.callTool({ name, arguments: args });
      const toolCalls: [string, Record<string, unknown>][] = [
        [
          'set_finance_settings',
          {
            rootId,
            currency: 'GBP',
            startMonth: '2026-08',
            horizonMonths: 2,
            openingCash: 100,
            emergencyFundMonths: 3,
            timezone: 'Europe/London',
          },
        ],
        ['read_finance_accounts', { rootId, month: '2026-08' }],
        ['create_finance_account', { rootId, name: 'Current', type: 'current' }],
        ['set_finance_account', { rootId, accountId, name: 'Current', type: 'current' }],
        ['finance_loan', { rootId, accountId, overpayment: 5 }],
        [
          'create_finance_line',
          {
            rootId,
            name: 'Groceries',
            section: 'Living',
            flow: 'expense',
            accountId,
            amount: 300,
          },
        ],
        [
          'set_finance_line',
          {
            rootId,
            lineId,
            name: 'Groceries',
            section: 'Living',
            flow: 'expense',
            accountId,
            amount: 300,
          },
        ],
        [
          'list_finance_transactions',
          {
            rootId,
            month: '2026-08',
            accountId,
            from: '2026-08-01',
            to: '2026-08-31',
            search: 'Market',
            source: 'manual',
            minAmount: 10,
            maxAmount: 20,
            offset: 50,
            limit: 50,
          },
        ],
        [
          'set_finance_transaction',
          {
            rootId,
            transactionId,
            description: 'Market',
            date: '2026-08-12',
            amount: -12.4,
            accountId,
            lineId,
            cleared: true,
          },
        ],
        ['finance_cashflow', { rootId }],
        ['finance_month', { rootId, month: '2026-08' }],
        [
          'import_finance_statement',
          {
            rootId,
            accountId,
            csv: 'date,amount,description\n2026-08-01,-1,Market',
          },
        ],
      ];
      const results = [];
      for (const [name, args] of toolCalls) results.push(await invoke(name, args));
      expect(
        results.every((result) => result.isError !== true),
        JSON.stringify(results),
      ).toBe(true);
      expect(
        calls.map(({ method, path }) => [
          method,
          path.replace(`/api/v1/items/${rootId}/finance`, ''),
        ]),
      ).toEqual([
        ['PUT', ''],
        ['GET', '/accounts'],
        ['POST', '/accounts'],
        ['PUT', `/accounts/${accountId}`],
        ['GET', `/accounts/${accountId}/loan`],
        ['POST', '/lines'],
        ['PUT', `/lines/${lineId}`],
        ['GET', '/transactions'],
        ['PUT', `/transactions/${transactionId}`],
        ['GET', '/cashflow'],
        ['GET', '/months/2026-08'],
        ['POST', '/import'],
      ]);
      expect(calls[8]?.body).toMatchObject({
        description: 'Market',
        date: '2026-08-12',
        amount: -12.4,
        accountId,
        lineId,
        cleared: true,
      });
      expect(calls[11]?.body).toMatchObject({ accountId, commit: false });
      expect(calls[7]?.query).toContain('month=2026-08');
      expect(calls[7]?.query).toContain('from=2026-08-01');
      expect(calls[7]?.query).toContain('offset=50');
      expect(calls[7]?.query).toContain('minAmount=10');
      const malformed = await invoke('add_finance_transaction', {
        rootId,
        description: 'Bad money',
        date: '2026-08-12',
        amount: 1.001,
        accountId,
      });
      expect(malformed.isError).toBe(true);
      expect(calls).toHaveLength(12);
    } finally {
      await connected.close();
    }
  });

  it('exposes habit writes through the authenticated API session', async () => {
    const habitId = '11111111-1111-4111-8111-111111111111';
    const requests: { method: string; url: string; body: unknown }[] = [];
    const connected = await connect('owner', (url, init) => {
      if (url.endsWith('/public/v1/auth/token')) {
        return Promise.resolve(
          Response.json({
            accessToken: 'jwt-owner',
            tokenType: 'Bearer',
            expiresInSeconds: 600,
          }),
        );
      }
      requests.push({
        method: init?.method ?? 'GET',
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      return Promise.resolve(
        Response.json({
          id: '22222222-2222-4222-8222-222222222222',
          occurredOn: '2026-09-14',
          completed: true,
          quantity: 2,
        }),
      );
    });
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (url.endsWith('/public/v1/auth/token')) {
        return Response.json({
          accessToken: 'jwt-owner',
          tokenType: 'Bearer',
          expiresInSeconds: 600,
        });
      }
      requests.push({
        method: init?.method ?? 'GET',
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      return Response.json({
        id: '22222222-2222-4222-8222-222222222222',
        occurredOn: '2026-09-14',
        completed: true,
        quantity: 2,
      });
    });
    try {
      const result = await connected.client.callTool({
        name: 'check_in_habit',
        arguments: { habitId, occurredOn: '2026-09-14', completed: true, quantity: 2 },
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(requests).toEqual([
        {
          method: 'PUT',
          url: `http://nix.test/api/v1/items/${habitId}/habit/check-ins/2026-09-14`,
          body: { completed: true, quantity: 2 },
        },
      ]);
    } finally {
      await connected.close();
    }
  });

  it('preflights template input on Core and applies through the distinct Collab origin', async () => {
    const collab = 'http://collab.nix.test';
    const templateId = '33333333-3333-4333-8333-333333333333';
    const sourceId = '11111111-1111-4111-8111-111111111111';
    const urls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      urls.push(url);
      if (url === `${API}/api/v1/templates/${templateId}`) {
        return Response.json({
          id: templateId,
          workspaceId: WORKSPACE,
          title: 'Project seed',
          description: null,
          origin: 'user',
          revision: 7,
          includeBody: false,
          includeChildren: false,
          fieldCount: 0,
          viewCount: 0,
          childCount: 0,
          viewKinds: [],
          capabilities: { canEdit: true, canDelete: true, canExport: true, canApply: true },
          updatedAt: '2026-09-20T09:00:00Z',
          initialization: { version: 1, inputs: [], rules: [], references: [] },
          root: {
            sourceId,
            itemType: 'note',
            title: 'Project seed',
            seq: '1',
            properties: {},
            schema: { properties: [], declared: [], inherit: false },
            views: null,
            hasBody: false,
            recurrence: null,
            children: [],
          },
        });
      }
      if (url === `${API}/api/v1/templates/${templateId}/preflight`) {
        return Response.json({
          templateId,
          templateRevision: 8,
          mode: 'create',
          additions: { fields: 0, views: 0, items: 1 },
          conflicts: [],
          canApply: true,
          initializationPreview: [],
          resolvedInputs: {},
          textBindings: {},
          referenceMappings: {},
        });
      }
      if (url === `${collab}/templates/applications`) {
        return Response.json({
          applicationId: '55555555-5555-4555-8555-555555555555',
          templateId,
          targetItemId: sourceId,
          alreadyApplied: false,
          createdItems: [{ sourceId, itemId: sourceId, itemType: 'note' }],
          resolvedInputs: {},
          textBindings: {},
          referenceMappings: {},
          writtenTargetItemIds: [],
          operationId: '44444444-4444-4444-8444-444444444444',
        });
      }
      throw new Error(`Unexpected route: ${url}`);
    });

    const connected = await connect(
      'owner',
      () =>
        Promise.resolve(
          Response.json({ accessToken: 'jwt-owner', tokenType: 'Bearer', expiresInSeconds: 600 }),
        ),
      collab,
    );
    try {
      const result = await connected.client.callTool({
        name: 'apply_template',
        arguments: { templateId, mode: 'create', inputs: {} },
      });
      expect(result.isError).not.toBe(true);
      const content = result.content as readonly {
        readonly type: string;
        readonly text?: string;
      }[];
      expect(
        JSON.parse(content[0]?.type === 'text' ? (content[0].text ?? '{}') : '{}'),
      ).toMatchObject({
        application: { applicationId: '55555555-5555-4555-8555-555555555555' },
        resume: { expectedRevision: 8 },
      });
      expect(urls).toContain(`${API}/api/v1/templates/${templateId}/preflight`);
      expect(urls).toContain(`${collab}/templates/applications`);
      expect(urls).not.toContain(`${collab}/collab/templates/applications`);
      expect(urls).not.toContain(`${API}/collab/templates/applications`);
    } finally {
      await connected.close();
    }
  });

  it('resumes a pending template draft from Core and replays the original begin command', async () => {
    const collab = 'http://collab.nix.test';
    const templateId = '33333333-3333-4333-8333-333333333333';
    const operationId = '44444444-4444-4444-8444-444444444444';
    const jobId = '55555555-5555-4555-8555-555555555555';
    const sourceId = '11111111-1111-4111-8111-111111111111';
    const collabBodies: unknown[] = [];
    const urls: string[] = [];
    let beginCount = 0;
    const fetchImpl: FetchImpl = (url, init) => {
      urls.push(url);
      if (url.endsWith('/public/v1/auth/token')) {
        return Promise.resolve(
          Response.json({ accessToken: 'jwt-owner', tokenType: 'Bearer', expiresInSeconds: 600 }),
        );
      }
      if (url === `${collab}/templates/${templateId}/drafts`) {
        collabBodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : null);
        beginCount += 1;
        return Promise.resolve(
          Response.json(
            {
              operationId,
              templateId,
              fileTransferJobId: beginCount === 1 ? jobId : null,
              fileTransferPending: beginCount === 1,
              title: 'Project seed',
              description: null,
              initialization: { version: 1, inputs: [], rules: [], references: [] },
              expiresAt: '2026-09-20T10:00:00Z',
              root: {
                sourceId,
                itemType: 'note',
                title: 'Project seed',
                seq: '1',
                properties: {},
                schema: null,
                views: null,
                hasBody: false,
                recurrence: null,
                children: [],
              },
              itemMappings: [],
              bodyCopies: [],
            },
            { status: beginCount === 1 ? 202 : 201 },
          ),
        );
      }
      if (url === `${API}/api/v1/operations/${jobId}`) {
        return Promise.resolve(
          Response.json({
            id: jobId,
            kind: 'template.files.copy',
            status: 'completed',
            result: null,
            errorCode: null,
            errorDetail: null,
            attempts: 1,
            cancellationRequested: false,
            createdAt: '2026-09-20T09:00:00Z',
            completedAt: '2026-09-20T09:00:01Z',
          }),
        );
      }
      return Promise.reject(new Error(`Unexpected route: ${url}`));
    };

    vi.stubGlobal('fetch', fetchImpl);
    const connected = await connect('owner', fetchImpl, collab);
    try {
      const result = await connected.client.callTool({
        name: 'begin_template_draft',
        arguments: { templateId, idempotencyKey: 'draft-resume-key' },
      });
      expect(result.isError, JSON.stringify({ result, urls, collabBodies })).not.toBe(true);
      expect(beginCount).toBe(1);
      const receiptText =
        (result.content as readonly { type: string; text?: string }[])[0]?.text ?? '{}';
      const receipt = JSON.parse(receiptText) as {
        resume: { kind: string; jobId: string; request: unknown };
      };
      expect(receipt.resume).toMatchObject({
        kind: 'draft',
        jobId,
        request: { idempotencyKey: 'draft-resume-key', templateId },
      });
      const resumed = await connected.client.callTool({
        name: 'resume_template_file_copy',
        arguments: receipt.resume,
      });
      expect(resumed.isError, JSON.stringify(resumed)).not.toBe(true);
      expect(beginCount).toBe(2);
      expect(collabBodies).toEqual([
        { idempotencyKey: 'draft-resume-key' },
        { idempotencyKey: 'draft-resume-key' },
      ]);
      expect(urls).toContain(`${API}/api/v1/operations/${jobId}`);
    } finally {
      await connected.close();
    }
  });

  it('carries only exchanged JWTs and preserves Core authorization between two principals', async () => {
    const authorizationHeaders: string[] = [];
    const fetchImpl: FetchImpl = (url, init) => {
      if (url.endsWith('/public/v1/auth/token')) {
        if (typeof init?.body !== 'string') {
          return Promise.reject(new Error('Expected a JSON exchange body.'));
        }
        const body = JSON.parse(init.body) as { token: string };
        return Promise.resolve(
          Response.json({
            accessToken: body.token === 'nixpat_owner' ? 'jwt-owner' : 'jwt-outsider',
            tokenType: 'Bearer',
            expiresInSeconds: 600,
          }),
        );
      }

      const headers = new Headers(init?.headers);
      const authorization = headers.get('authorization') ?? '';
      authorizationHeaders.push(authorization);
      if (authorization === 'Bearer jwt-owner') {
        return Promise.resolve(Response.json({ items: [workspace()], nextCursor: null }));
      }
      return Promise.resolve(
        Response.json(
          { code: 'workspaces.not_found', detail: 'No workspace is visible.' },
          { status: 403 },
        ),
      );
    };
    vi.stubGlobal('fetch', fetchImpl);

    const owner = await connect('owner', fetchImpl);
    const outsider = await connect('outsider', fetchImpl);
    try {
      const allowed = await owner.client.callTool({ name: 'list_workspaces', arguments: {} });
      const refused = await outsider.client.callTool({ name: 'list_workspaces', arguments: {} });

      expect(allowed.isError, JSON.stringify(allowed)).not.toBe(true);
      expect(JSON.stringify(allowed.content)).toContain(WORKSPACE);
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain('status 403');
      expect(authorizationHeaders).toEqual(['Bearer jwt-owner', 'Bearer jwt-outsider']);
      expect(JSON.stringify({ allowed, refused, authorizationHeaders })).not.toContain('nixpat_');
    } finally {
      await owner.close();
      await outsider.close();
    }
  });

  it('bounds paging inputs and requires confirm true for destructive tools', async () => {
    const connected = await connect('owner', async () => unexpectedRequest());
    try {
      const oversizedCursor = await connected.client.callTool({
        name: 'list_workspace_members',
        arguments: { workspaceId: WORKSPACE, cursor: 'x'.repeat(513) },
      });
      const unconfirmed = await connected.client.callTool({
        name: 'leave_workspace',
        arguments: { workspaceId: WORKSPACE },
      });
      expect(oversizedCursor.isError).toBe(true);
      expect(unconfirmed.isError).toBe(true);
    } finally {
      await connected.close();
    }
  });

  it('routes document import recovery through Core and requires explicit cancel confirmation', async () => {
    const importId = 'a1111111-1111-4111-8111-111111111111';
    const operationId = 'a2222222-2222-4222-8222-222222222222';
    const calls: string[] = [];
    const fetchMock: FetchImpl = async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/public/v1/auth/token')) {
        return Response.json({
          accessToken: 'jwt-owner',
          tokenType: 'Bearer',
          expiresInSeconds: 600,
        });
      }
      if (url.endsWith(`/api/v1/imports/${importId}`) && (init?.method ?? 'GET') === 'GET') {
        return Response.json({
          id: importId,
          workspaceId: WORKSPACE,
          uploadId: 'a3333333-3333-4333-8333-333333333333',
          parentId: null,
          format: 'txt',
          title: 'notes',
          status: 'preview_ready',
          previewOperationId: operationId,
          commitOperationId: null,
          itemCount: 1,
          assetCount: 0,
          loss: [],
          omissions: [],
          rootItemId: null,
          failureCode: null,
          expiresAt: '2026-09-01T01:00:00Z',
          completedAt: null,
        });
      }
      if (url.endsWith(`/api/v1/imports/${importId}/commit`)) {
        return Response.json(
          {
            id: operationId,
            kind: 'import.commit',
            status: 'queued',
            result: null,
            errorCode: null,
            errorDetail: null,
            attempts: 0,
            cancellationRequested: false,
            createdAt: '2026-09-01T00:00:00Z',
            completedAt: null,
          },
          { status: 202 },
        );
      }
      if (url.endsWith(`/api/v1/imports/${importId}`) && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return unexpectedRequest();
    };
    vi.stubGlobal('fetch', fetchMock);
    const connected = await connect('owner', fetchMock);
    try {
      const state = await connected.client.callTool({
        name: 'get_document_import',
        arguments: { importId },
      });
      const receipt = await connected.client.callTool({
        name: 'commit_document_import',
        arguments: { importId, wait: false },
      });
      const unconfirmed = await connected.client.callTool({
        name: 'cancel_document_import',
        arguments: { importId },
      });
      const cancelled = await connected.client.callTool({
        name: 'cancel_document_import',
        arguments: { importId, confirm: true },
      });
      expect(state.isError, JSON.stringify({ state, calls })).not.toBe(true);
      expect(JSON.stringify(state.content)).toContain('preview_ready');
      expect(receipt.isError).not.toBe(true);
      expect(JSON.stringify(receipt.content)).toContain(operationId);
      expect(unconfirmed.isError).toBe(true);
      expect(cancelled.isError).not.toBe(true);
      expect(calls.slice(1).map((call) => call.replace(API, ''))).toEqual([
        `GET /api/v1/imports/${importId}`,
        `POST /api/v1/imports/${importId}/commit`,
        `DELETE /api/v1/imports/${importId}`,
      ]);
      expect(JSON.stringify({ state, receipt, cancelled })).not.toContain('uploadUrl');
    } finally {
      await connected.close();
    }
  });

  it('previews a pending pet tool call through pet_tool_run without claiming or executing it', async () => {
    const workspaceId = '22222222-2222-4222-8222-222222222222';
    const petId = '33333333-3333-4333-8333-333333333333';
    const toolId = 'tool-1';
    const requests: { method: string; url: string; body: unknown }[] = [];
    const toolArguments = JSON.stringify({
      operation: 'list_items',
      itemId: '',
      parentId: '',
      title: '',
      markdown: '',
      query: '',
      propertiesJson: '',
    });
    const fetchImpl: FetchImpl = (url, init) => {
      if (url.endsWith('/public/v1/auth/token')) {
        return Promise.resolve(
          Response.json({ accessToken: 'jwt-owner', tokenType: 'Bearer', expiresInSeconds: 600 }),
        );
      }
      requests.push({
        method: init?.method ?? 'GET',
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      return Promise.resolve(
        Response.json({
          provider: 'chatgpt',
          status: 'connected',
          reason: 'Connected',
          canConnect: false,
          tools: [
            { id: toolId, arguments: toolArguments, status: 'pending', result: '', claimId: '' },
          ],
        }),
      );
    };
    vi.stubGlobal('fetch', fetchImpl);
    const connected = await connect('owner', fetchImpl);
    try {
      const result = await connected.client.callTool({
        name: 'pet_tool_run',
        arguments: { workspaceId, petId, toolId, decision: 'preview' },
      });
      const runtimeCalls = requests.filter((request) => request.url.endsWith('/pets/runtime'));
      expect(runtimeCalls).toHaveLength(1);
      expect(runtimeCalls[0]?.body).toMatchObject({ operation: 'read' });
      expect(result.isError).not.toBe(true);
      const content = result.content as { type: string; text: string }[];
      expect(JSON.parse(content[0]?.text ?? '')).toMatchObject({
        toolId,
        status: 'pending',
        preview: {
          headline: 'I will list the top-level items in this workspace to find what to work on.',
          counts: { writes: 0 },
        },
      });
    } finally {
      await connected.close();
    }
  });

  it('forwards pet_runtime tool_claim/tool_result through the same request shape as the CLI', async () => {
    const workspaceId = '22222222-2222-4222-8222-222222222222';
    const petId = '33333333-3333-4333-8333-333333333333';
    const toolId = 'tool-1';
    const requests: { method: string; url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl: FetchImpl = (url, init) => {
      if (url.endsWith('/public/v1/auth/token')) {
        return Promise.resolve(
          Response.json({ accessToken: 'jwt-owner', tokenType: 'Bearer', expiresInSeconds: 600 }),
        );
      }
      const body = (typeof init?.body === 'string' ? JSON.parse(init.body) : {}) as Record<
        string,
        unknown
      >;
      requests.push({ method: init?.method ?? 'GET', url, body });
      return Promise.resolve(
        Response.json({
          provider: 'chatgpt',
          status: 'connected',
          reason: 'Connected',
          canConnect: false,
          mode: body.mode,
        }),
      );
    };
    vi.stubGlobal('fetch', fetchImpl);
    const connected = await connect('owner', fetchImpl);
    try {
      const claim = await connected.client.callTool({
        name: 'pet_runtime',
        arguments: {
          operation: 'tool_claim',
          workspaceId,
          petId,
          toolId,
          requestId: 'req-1',
        },
      });
      const result = await connected.client.callTool({
        name: 'pet_runtime',
        arguments: {
          operation: 'tool_result',
          workspaceId,
          petId,
          toolId,
          requestId: 'req-1',
          toolResult: 'done',
          toolSuccess: true,
        },
      });
      expect(claim.isError).not.toBe(true);
      expect(result.isError).not.toBe(true);
      const runtimeCalls = requests.filter((request) => request.url.endsWith('/pets/runtime'));
      expect(runtimeCalls.map((call) => call.body.operation)).toEqual([
        'tool_claim',
        'tool_result',
      ]);
      expect(runtimeCalls[0]?.body).toMatchObject({
        workspaceId,
        petId,
        toolId,
        requestId: 'req-1',
      });
      expect(runtimeCalls[1]?.body).toMatchObject({
        toolId,
        requestId: 'req-1',
        toolResult: 'done',
        toolSuccess: true,
        mode: '',
      });
    } finally {
      await connected.close();
    }
  });

  it('forwards pet_runtime watch as a GET long-poll with after as a query parameter', async () => {
    const workspaceId = '22222222-2222-4222-8222-222222222222';
    const petId = '33333333-3333-4333-8333-333333333333';
    const requests: { method: string; url: string }[] = [];
    const fetchImpl: FetchImpl = (url, init) => {
      if (url.endsWith('/public/v1/auth/token')) {
        return Promise.resolve(
          Response.json({ accessToken: 'jwt-owner', tokenType: 'Bearer', expiresInSeconds: 600 }),
        );
      }
      requests.push({ method: init?.method ?? 'GET', url });
      return Promise.resolve(
        Response.json({
          provider: 'chatgpt',
          status: 'connected',
          reason: 'Connected',
          canConnect: false,
          revision: 9,
        }),
      );
    };
    vi.stubGlobal('fetch', fetchImpl);
    const connected = await connect('owner', fetchImpl);
    try {
      const result = await connected.client.callTool({
        name: 'pet_runtime',
        arguments: {
          operation: 'watch',
          workspaceId,
          petId,
          after: 5,
          rootItemId: workspaceId,
        },
      });
      expect(result.isError).not.toBe(true);
      const watchCall = requests.find((request) =>
        request.url.includes('/pets/runtime/note/watch'),
      );
      expect(watchCall?.method).toBe('GET');
      const query = new URL(watchCall?.url ?? '').searchParams;
      expect(query.get('workspaceId')).toBe(workspaceId);
      expect(query.get('petId')).toBe(petId);
      expect(query.has('mode')).toBe(false);
      expect(query.get('after')).toBe('5');
      expect(query.get('rootItemId')).toBe(workspaceId);
    } finally {
      await connected.close();
    }
  });

  it('rejects pet_runtime tool_claim without a toolId before contacting the service', async () => {
    const requests: string[] = [];
    const fetchImpl: FetchImpl = (url) => {
      if (url.endsWith('/public/v1/auth/token')) {
        return Promise.resolve(
          Response.json({ accessToken: 'jwt-owner', tokenType: 'Bearer', expiresInSeconds: 600 }),
        );
      }
      requests.push(url);
      return unexpectedRequest();
    };
    vi.stubGlobal('fetch', fetchImpl);
    const connected = await connect('owner', fetchImpl);
    try {
      const result = await connected.client.callTool({
        name: 'pet_runtime',
        arguments: {
          operation: 'tool_claim',
          workspaceId: '22222222-2222-4222-8222-222222222222',
          petId: '33333333-3333-4333-8333-333333333333',
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('Provide --tool-id.');
      expect(requests.filter((url) => url.endsWith('/pets/runtime'))).toHaveLength(0);
    } finally {
      await connected.close();
    }
  });
});

describe('nixctl mcp notification, reminder and automation tools', () => {
  const RULE = '33333333-3333-4333-8333-333333333333';
  const ITEM = '11111111-1111-4111-8111-111111111111';
  const LIFE_TOOLS = [
    'list_notifications',
    'mark_notification_read',
    'mark_all_notifications_read',
    'get_notification_preferences',
    'set_notification_preferences',
    'set_reminder',
    'clear_reminder',
    'list_automations',
    'get_automation',
    'create_automation',
    'update_automation',
    'set_automation_enabled',
    'delete_automation',
    'list_automation_runs',
    'run_automation',
    'test_automation',
  ];

  function automationRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: RULE,
      workspaceId: WORKSPACE,
      name: 'Morning review',
      enabled: true,
      scopeItemId: null,
      trigger: { type: 'schedule', freq: 'daily', interval: 1, time: '08:00' },
      conditions: [],
      actions: [{ type: 'notify', title: 'Review', body: '' }],
      revision: 4,
      consecutiveFailures: 0,
      disabledReason: null,
      lastRunAt: null,
      createdAt: '2026-09-30T12:00:00Z',
      updatedAt: '2026-09-30T12:00:00Z',
      ...overrides,
    };
  }

  function stub(respond: (method: string, path: string) => Response): {
    fetchImpl: FetchImpl;
    calls: { method: string; path: string; body: unknown }[];
  } {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const fetchImpl: FetchImpl = (url, init) => {
      if (url.endsWith('/public/v1/auth/token')) {
        return Promise.resolve(
          Response.json({ accessToken: 'jwt-owner', tokenType: 'Bearer', expiresInSeconds: 600 }),
        );
      }
      const method = init?.method ?? 'GET';
      const path = new URL(url).pathname;
      calls.push({
        method,
        path,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      return Promise.resolve(respond(method, path));
    };
    vi.stubGlobal('fetch', fetchImpl);
    return { fetchImpl, calls };
  }

  it('keeps every new tool input schema within the 4800-byte companion budget', async () => {
    const connected = await connect('owner', async () => unexpectedRequest());
    try {
      const tools = (await connected.client.listTools()).tools.filter((tool) =>
        LIFE_TOOLS.includes(tool.name),
      );
      expect(tools).toHaveLength(LIFE_TOOLS.length);
      for (const tool of tools) {
        expect(JSON.stringify(tool.inputSchema).length, tool.name).toBeLessThanOrEqual(4800);
      }
    } finally {
      await connected.close();
    }
  });

  it('creates a rule and updates it by merging onto the current rule behind its revision', async () => {
    const { fetchImpl, calls } = stub((method) =>
      Response.json(automationRule(method === 'PUT' ? { name: 'Evening', revision: 5 } : {}), {
        status: method === 'POST' ? 201 : 200,
      }),
    );
    const connected = await connect('owner', fetchImpl);
    try {
      const created = await connected.client.callTool({
        name: 'create_automation',
        arguments: {
          workspaceId: WORKSPACE,
          name: 'Morning review',
          trigger: { type: 'schedule', freq: 'daily', interval: 1, time: '08:00' },
          actions: [{ type: 'notify', title: 'Review' }],
        },
      });
      expect(created.isError).toBeFalsy();
      const updated = await connected.client.callTool({
        name: 'update_automation',
        arguments: { ruleId: RULE, name: 'Evening' },
      });
      expect(updated.isError).toBeFalsy();

      expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
        `POST /api/v1/workspaces/${WORKSPACE}/automations`,
        `GET /api/v1/automations/${RULE}`,
        `PUT /api/v1/automations/${RULE}`,
      ]);
      expect(calls[0]?.body).toEqual({
        name: 'Morning review',
        enabled: true,
        scopeItemId: null,
        trigger: { type: 'schedule', freq: 'daily', interval: 1, time: '08:00' },
        conditions: [],
        actions: [{ type: 'notify', title: 'Review' }],
      });
      expect(calls[2]?.body).toMatchObject({
        expectedRevision: 4,
        rule: { name: 'Evening', trigger: { type: 'schedule' } },
      });
    } finally {
      await connected.close();
    }
  });

  it('returns an out-of-scope refusal in Core its own words with how to fix it', async () => {
    const { fetchImpl } = stub(() =>
      Response.json(
        {
          title: 'Access token out of scope',
          status: 403,
          code: 'auth.insufficient_scope',
          detail: `Principal 'p' is authenticated, but personal access token 't' does not reach POST /api/v1/automations/${RULE}/run: it requires admin.`,
        },
        { status: 403, headers: { 'content-type': 'application/problem+json' } },
      ),
    );
    const connected = await connect('owner', fetchImpl);
    try {
      const result = await connected.client.callTool({
        name: 'run_automation',
        arguments: { ruleId: RULE, itemId: ITEM },
      });
      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).toContain('it requires admin');
      expect(text).toContain('nixctl auth login');
    } finally {
      await connected.close();
    }
  });

  it('requires confirmation before deleting a rule', async () => {
    const connected = await connect('owner', async () => unexpectedRequest());
    try {
      const result = await connected.client.callTool({
        name: 'delete_automation',
        arguments: { ruleId: RULE, confirm: false },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('confirm: true');
    } finally {
      await connected.close();
    }
  });

  it('saves notification preferences behind the revision read and sets a zoned reminder', async () => {
    const preferences = {
      revision: 2,
      timeZone: 'Europe/London',
      quietStart: null,
      quietEnd: null,
      dueReminderTime: '09:00',
      dueReminders: true,
      habitReminders: true,
      mutedContainerIds: [],
    };
    const { fetchImpl, calls } = stub((method, path) => {
      if (path === '/api/v1/me/preferences') return Response.json(preferences);
      return Response.json({
        id: ITEM,
        workspaceId: WORKSPACE,
        parentId: null,
        type: 'note',
        title: 'Pay rent',
        hasChildren: false,
        seq: 1,
        lifecycleState: 'active',
        properties: {},
        createdAt: '2026-09-30T12:00:00Z',
        updatedAt: '2026-09-30T12:00:00Z',
      });
    });
    const connected = await connect('owner', fetchImpl);
    try {
      const saved = await connected.client.callTool({
        name: 'set_notification_preferences',
        arguments: { quiet: '22:00-07:00', habitReminders: false, mute: [ITEM] },
      });
      expect(saved.isError).toBeFalsy();
      const reminded = await connected.client.callTool({
        name: 'set_reminder',
        arguments: { itemId: ITEM, when: '2026-10-01T09:00', zone: 'Europe/London' },
      });
      expect(reminded.isError).toBeFalsy();

      expect(calls[1]).toMatchObject({
        method: 'PUT',
        body: {
          expectedRevision: 2,
          preferences: {
            quietStart: '22:00',
            quietEnd: '07:00',
            habitReminders: false,
            dueReminders: true,
            mutedContainerIds: [ITEM],
          },
        },
      });
      expect(calls[2]).toMatchObject({
        method: 'PATCH',
        path: `/api/v1/items/${ITEM}/properties`,
        body: { properties: { reminder: '2026-10-01T09:00:00+01:00[Europe/London]' } },
      });
    } finally {
      await connected.close();
    }
  });
});

async function connect(profileName: string, fetchImpl: FetchImpl, collabUrl?: string) {
  const server = await createWorkspaceMcpServer({
    profileName,
    resolve: (requestedProfile) =>
      Promise.resolve(
        openSession({
          profile: {
            apiUrl: API,
            ...(collabUrl === undefined ? {} : { collabUrl }),
            token: requestedProfile === 'owner' ? 'nixpat_owner' : 'nixpat_outsider',
          },
          fetchImpl,
        }),
      ),
  });
  const client = new Client({ name: 'nixctl-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function workspace(): Record<string, unknown> {
  return {
    id: WORKSPACE,
    name: 'Owner workspace',
    versionRetentionDays: 90,
    storageQuotaBytes: '10737418240',
    createdAt: '2026-08-30T12:00:00Z',
    kind: 'personal',
    canRename: true,
    canManageMembers: true,
    canLeave: false,
    canUseDailyNotes: true,
    pendingInvitationId: null,
    lifecycleState: 'active',
    archivedAt: null,
  };
}

function unexpectedRequest(): Promise<Response> {
  return Promise.reject(new Error('No request was expected.'));
}
