import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExitCode, toFailure } from '../output.ts';
import { captureText, makeProfile } from './cli.test-helper.ts';
import {
  buildCreateRule,
  createAutomation,
  deleteAutomation,
  listAutomationRuns,
  mergeRule,
  parseRuleFile,
  patchFromFlags,
  runAutomation,
  setAutomationEnabled,
  testAutomation,
  updateAutomation,
  type RuleFlags,
} from './automations.ts';

const API = 'http://nix.test';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const RULE = '33333333-3333-4333-8333-333333333333';
const ITEM = '11111111-1111-4111-8111-111111111111';
const SCOPE = '55555555-5555-4555-8555-555555555555';

function rule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RULE,
    workspaceId: WORKSPACE,
    name: 'Morning review',
    enabled: true,
    scopeItemId: null,
    trigger: { type: 'schedule', freq: 'daily', interval: 1, time: '08:00' },
    conditions: [],
    actions: [{ type: 'notify', title: 'Review {date}', body: '' }],
    revision: 4,
    consecutiveFailures: 0,
    disabledReason: null,
    lastRunAt: null,
    createdAt: '2026-09-30T12:00:00Z',
    updatedAt: '2026-09-30T12:00:00Z',
    ...overrides,
  };
}

describe('buildCreateRule from flags', () => {
  it('builds a weekly schedule that notifies', () => {
    expect(
      buildCreateRule({
        name: 'Weekly plan',
        schedule: 'weekly',
        at: '07:30',
        weekdays: 'MO,fr',
        every: '2',
        timeZone: 'Europe/London',
        start: '2026-10-05',
        notify: 'Plan the week',
        notifyBody: 'Open the board',
      }),
    ).toEqual({
      name: 'Weekly plan',
      enabled: true,
      scopeItemId: null,
      trigger: {
        type: 'schedule',
        freq: 'weekly',
        interval: 2,
        time: '07:30',
        weekdays: ['mo', 'fr'],
        timeZone: 'Europe/London',
        startDate: '2026-10-05',
      },
      conditions: [],
      actions: [{ type: 'notify', title: 'Plan the week', body: 'Open the board' }],
    });
  });

  it('builds a date rule with conditions and a set_property on the triggering item', () => {
    const built = buildCreateRule({
      name: 'Flag overdue',
      scope: SCOPE,
      disabled: true,
      whenDate: 'due_date',
      offset: '-60',
      at: '09:00',
      if: ['status!=done', 'priority=1'],
      ifEmpty: ['owner'],
      ifSet: ['estimate'],
      set: ['status=overdue', 'flagged=true'],
    });
    expect(built.enabled).toBe(false);
    expect(built.scopeItemId).toBe(SCOPE);
    expect(built.trigger).toEqual({
      type: 'date_arrives',
      key: 'due_date',
      offsetMinutes: -60,
      time: '09:00',
    });
    expect(built.conditions).toEqual([
      { key: 'status', op: 'not_equals', value: 'done' },
      { key: 'priority', op: 'equals', value: 1 },
      { key: 'owner', op: 'is_empty' },
      { key: 'estimate', op: 'is_not_empty' },
    ]);
    expect(built.actions).toEqual([
      { type: 'set_property', target: 'triggering_item', key: 'status', value: 'overdue' },
      { type: 'set_property', target: 'triggering_item', key: 'flagged', value: true },
    ]);
  });

  it('builds a property rule with from and to, and a create_item under the triggering item', () => {
    const built = buildCreateRule({
      name: 'Follow up',
      whenChanged: 'status',
      from: 'open',
      to: 'done',
      create: 'Follow up on {item.title}',
      createType: 'note',
      createProp: ['priority=2'],
    });
    expect(built.trigger).toEqual({
      type: 'property_changed',
      key: 'status',
      from: { value: 'open' },
      to: { value: 'done' },
    });
    expect(built.actions).toEqual([
      {
        type: 'create_item',
        parent: 'triggering_item',
        itemType: 'note',
        title: 'Follow up on {item.title}',
        properties: { priority: 2 },
      },
    ]);
  });

  it('creates under the scope by default on a schedule rule, and under a named item when asked', () => {
    const scheduled = buildCreateRule({
      name: 'Daily log',
      scope: SCOPE,
      schedule: 'daily',
      at: '06:00',
      create: 'Log {date}',
    });
    expect(scheduled.actions[0]).toMatchObject({ parent: 'scope', itemType: 'note' });

    const named = buildCreateRule({
      name: 'Daily log',
      schedule: 'daily',
      at: '06:00',
      create: 'Log {date}',
      createUnder: ITEM,
    });
    expect(named.actions[0]).toMatchObject({ parent: { itemId: ITEM } });
  });

  it('targets a named item with --set-item', () => {
    const built = buildCreateRule({
      name: 'Count',
      schedule: 'daily',
      at: '06:00',
      set: ['done=false'],
      setItem: ITEM,
    });
    expect(built.actions[0]).toEqual({
      type: 'set_property',
      target: { itemId: ITEM },
      key: 'done',
      value: false,
    });
  });

  it.each<[RuleFlags, string]>([
    [{ schedule: 'daily', at: '06:00', notify: 'x' }, '--name'],
    [{ name: 'n', notify: 'x' }, 'trigger'],
    [{ name: 'n', schedule: 'daily', at: '06:00' }, 'action'],
    [
      { name: 'n', schedule: 'daily', whenDate: 'due_date', at: '06:00', notify: 'x' },
      'one trigger',
    ],
    [{ name: 'n', schedule: 'hourly', at: '06:00', notify: 'x' }, '--schedule'],
    [{ name: 'n', schedule: 'daily', notify: 'x' }, '--at'],
    [{ name: 'n', schedule: 'daily', at: '6am', notify: 'x' }, '--at'],
    [{ name: 'n', schedule: 'daily', at: '06:00', weekdays: 'mo', notify: 'x' }, '--weekdays'],
    [{ name: 'n', schedule: 'weekly', at: '06:00', weekdays: 'mon', notify: 'x' }, '--weekdays'],
    [{ name: 'n', schedule: 'daily', at: '06:00', every: '0', notify: 'x' }, '--every'],
    [{ name: 'n', schedule: 'daily', at: '06:00', offset: '5', notify: 'x' }, '--offset'],
    [{ name: 'n', whenDate: 'due_date', offset: '20000', notify: 'x' }, '--offset'],
    [{ name: 'n', whenDate: '$due_set_by', notify: 'x' }, '$'],
    [{ name: 'n', whenChanged: 'status', at: '06:00', notify: 'x' }, '--at'],
    [{ name: 'n', whenDate: 'due_date', to: 'x', notify: 'x' }, '--to'],
    [{ name: 'n', whenDate: 'due_date', notifyBody: 'b', set: ['a=1'] }, '--notify-body'],
    [{ name: 'n', whenDate: 'due_date', if: ['nokey'], notify: 'x' }, '--if'],
    [{ name: 'n', whenDate: 'due_date', createType: 'note', notify: 'x' }, '--create-type'],
    [{ name: 'n', whenDate: 'due_date', setItem: ITEM, notify: 'x' }, '--set-item'],
    [{ name: 'n', whenDate: 'due_date', scope: 'nope', notify: 'x' }, '--scope'],
  ])('refuses %j naming %s', (flags, fragment) => {
    expect(() => buildCreateRule(flags)).toThrow(fragment);
  });
});

describe('rule files', () => {
  it('reads a rule file and lets --name, --scope and --disabled override it', () => {
    const file = parseRuleFile(
      JSON.stringify({
        name: 'From file',
        trigger: { type: 'property_changed', key: 'status' },
        actions: [{ type: 'notify', title: 'Changed' }],
      }),
      'rule.json',
    );
    expect(buildCreateRule({ name: 'Renamed', disabled: true }, file)).toEqual({
      name: 'Renamed',
      enabled: false,
      scopeItemId: null,
      trigger: { type: 'property_changed', key: 'status' },
      conditions: [],
      actions: [{ type: 'notify', title: 'Changed' }],
    });
  });

  it('accepts the output of automations get, keeping its revision for the update', () => {
    const file = parseRuleFile(JSON.stringify(rule({ name: 'Edited' })), 'rule.json');
    expect(file.revision).toBe(4);
    expect(file.rule.name).toBe('Edited');
  });

  it('refuses a file that is not JSON, not an object, or has members Core does not know', () => {
    expect(() => parseRuleFile('{', 'r.json')).toThrow('r.json is not valid JSON');
    expect(() => parseRuleFile('[]', 'r.json')).toThrow('r.json must be a JSON object');
    expect(() => parseRuleFile('{"trigers":{}}', 'r.json')).toThrow("'trigers'");
  });

  it('refuses mixing a file with trigger, condition or action flags', () => {
    const file = parseRuleFile('{"name":"n"}', 'r.json');
    expect(() => buildCreateRule({ notify: 'x' }, file)).toThrow('not both');
  });
});

describe('updating a rule', () => {
  it('merges only what was asked onto the current rule', () => {
    const current = rule() as never;
    const { patch } = patchFromFlags({ name: 'Evening review', schedule: 'daily', at: '20:00' });
    expect(mergeRule(current, patch)).toEqual({
      name: 'Evening review',
      enabled: true,
      scopeItemId: null,
      trigger: { type: 'schedule', freq: 'daily', interval: 1, time: '20:00' },
      conditions: [],
      actions: [{ type: 'notify', title: 'Review {date}', body: '' }],
    });
  });

  it('clears the scope with --scope none', () => {
    const current = rule({ scopeItemId: SCOPE }) as never;
    expect(mergeRule(current, patchFromFlags({ scope: 'none' }).patch).scopeItemId).toBeNull();
  });

  it('refuses an update that changes nothing', () => {
    expect(() => patchFromFlags({})).toThrow('Nothing to change');
  });
});

const server = setupServer(
  http.post(`${API}/public/v1/auth/token`, () =>
    HttpResponse.json({ accessToken: 'jwt-1', tokenType: 'Bearer', expiresInSeconds: 600 }),
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const withProfile = () => makeProfile({ apiUrl: API, token: 'nixpat_abc' });

describe('nixctl automations against Core', () => {
  it('creates from flags, posting the built rule to the workspace', async () => {
    const { env, done } = await withProfile();
    let sent: unknown;
    server.use(
      http.post(`${API}/api/v1/workspaces/:workspaceId/automations`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(rule(), { status: 201 });
      }),
    );

    const printed = JSON.parse(
      await captureText((out) =>
        createAutomation(
          'default',
          {
            workspace: WORKSPACE,
            name: 'Morning review',
            schedule: 'daily',
            at: '08:00',
            notify: 'Review {date}',
          },
          out,
          { env },
        ),
      ),
    ) as { id: string };

    expect(sent).toMatchObject({
      name: 'Morning review',
      trigger: { type: 'schedule', freq: 'daily', interval: 1, time: '08:00' },
    });
    expect(printed.id).toBe(RULE);
    await done();
  });

  it('surfaces an out-of-scope token as a refusal naming the admin scope and the fix', async () => {
    const { env, done } = await withProfile();
    server.use(
      http.post(`${API}/api/v1/workspaces/:workspaceId/automations`, () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Access token out of scope',
            status: 403,
            code: 'auth.insufficient_scope',
            detail:
              "Principal 'p' is authenticated, but personal access token 't' does not reach " +
              `POST /api/v1/workspaces/${WORKSPACE}/automations: it requires admin.`,
          },
          { status: 403, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    const failure = await captureText((out) =>
      createAutomation(
        'default',
        { workspace: WORKSPACE, name: 'n', schedule: 'daily', at: '08:00', notify: 'x' },
        out,
        { env },
      ),
    ).then(
      () => null,
      (error: unknown) => toFailure(error),
    );

    expect(failure?.code).toBe(ExitCode.Refused);
    expect(failure?.message).toContain('it requires admin');
    expect(failure?.message).toContain('nixctl auth login');
    await done();
  });

  it('updates from an edited get, behind the revision the file carries', async () => {
    const { env, dir, done } = await withProfile();
    const path = join(dir, 'rule.json');
    await writeFile(path, JSON.stringify(rule({ name: 'Edited', revision: 3 })));
    let sent: unknown;
    server.use(
      http.get(`${API}/api/v1/automations/:ruleId`, () => HttpResponse.json(rule())),
      http.put(`${API}/api/v1/automations/:ruleId`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(rule({ name: 'Edited', revision: 5 }));
      }),
    );

    await captureText((out) => updateAutomation('default', RULE, { file: path }, out, { env }));

    expect(sent).toMatchObject({ expectedRevision: 3, rule: { name: 'Edited' } });
    await done();
  });

  it('enables a disabled rule behind its current revision and skips one already enabled', async () => {
    const { env, done } = await withProfile();
    const puts: unknown[] = [];
    let current = rule({
      enabled: false,
      disabledReason: 'repeated_failures',
      consecutiveFailures: 5,
    });
    server.use(
      http.get(`${API}/api/v1/automations/:ruleId`, () => HttpResponse.json(current)),
      http.put(`${API}/api/v1/automations/:ruleId`, async ({ request }) => {
        puts.push(await request.json());
        current = rule({ revision: 5 });
        return HttpResponse.json(current);
      }),
    );

    await captureText((out) => setAutomationEnabled('default', RULE, true, out, { env }));
    await captureText((out) => setAutomationEnabled('default', RULE, true, out, { env }));

    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ expectedRevision: 4, rule: { enabled: true } });
    await done();
  });

  it('deletes only with --yes', async () => {
    const { env, done } = await withProfile();
    await expect(
      captureText((out) => deleteAutomation('default', RULE, false, out, { env })),
    ).rejects.toThrow('--yes');

    let deleted = false;
    server.use(
      http.delete(`${API}/api/v1/automations/:ruleId`, () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const printed = JSON.parse(
      await captureText((out) => deleteAutomation('default', RULE, true, out, { env })),
    ) as unknown;
    expect(deleted).toBe(true);
    expect(printed).toEqual({ id: RULE, deleted: true });
    await done();
  });

  it('runs and dry-runs with the optional item, and pages runs with a table on a terminal', async () => {
    const { env, done } = await withProfile();
    const bodies: unknown[] = [];
    const run = {
      id: '66666666-6666-4666-8666-666666666666',
      ruleId: RULE,
      itemId: ITEM,
      origin: 'manual',
      depth: 0,
      status: 'a_status_this_client_has_never_seen',
      reason: null,
      createdAt: '2026-09-30T12:00:00Z',
    };
    server.use(
      http.post(`${API}/api/v1/automations/:ruleId/run`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(run);
      }),
      http.post(`${API}/api/v1/automations/:ruleId/test`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ wouldRun: false, reason: 'conditions_unmet', actions: [] });
      }),
      http.get(`${API}/api/v1/automations/:ruleId/runs`, () =>
        HttpResponse.json({ items: [run], nextCursor: null }),
      ),
    );

    await captureText((out) => runAutomation('default', RULE, { item: ITEM }, out, { env }));
    const tested = JSON.parse(
      await captureText((out) => testAutomation('default', RULE, {}, out, { env })),
    ) as { reason: string };
    const table = await captureText(
      (out) => listAutomationRuns('default', RULE, {}, out, { env }),
      true,
    );

    expect(bodies).toEqual([{ itemId: ITEM }, { itemId: null }]);
    expect(tested.reason).toBe('conditions_unmet');
    expect(table).toContain('a_status_this_client_has_never_seen');
    await done();
  });
});
