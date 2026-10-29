import { vi } from 'vitest';

import { STUB_WORKSPACE_ID } from './resources/items';
import { requestUrl } from '../request-url';
import { json } from '../json-response';

/**
 * The automation routes (ADR-0051 section 6), layered over the Core stub.
 *
 * Call after `stubCoreApi`: it wraps whatever `fetch` that installed, answers the automation paths
 * itself and hands every other request through, so a page test gets the whole application and a
 * stateful rule store without the Core stub growing another thousand lines.
 */

export interface StubAutomationRule {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly scopeItemId: string | null;
  readonly trigger: Readonly<Record<string, unknown>>;
  readonly conditions: readonly unknown[];
  readonly actions: readonly unknown[];
  readonly revision: number;
  readonly consecutiveFailures: number;
  readonly disabledReason: string | null;
  readonly lastRunAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StubAutomationRun {
  readonly id: string;
  readonly ruleId: string;
  readonly itemId: string | null;
  readonly origin: string;
  readonly depth: number;
  readonly status: string;
  readonly reason: string | null;
  readonly createdAt: string;
}

export interface StubAutomationOptions {
  readonly rules?: readonly StubAutomationRule[];
  /** Runs per rule, newest first. Served 2 to a page so paging is exercised. */
  readonly runs?: Readonly<Record<string, readonly StubAutomationRun[]>>;
  readonly listFails?: boolean;
  /** Makes the next save answer 409 automation.conflict, after bumping the stored revision. */
  readonly conflictOnce?: boolean;
  /** Makes every save answer 422 automation.invalid with this detail. */
  readonly invalidDetail?: string;
  /** What a dry run reports. */
  readonly testResult?: Readonly<Record<string, unknown>>;
  /** What Run now records. */
  readonly runResult?: Partial<StubAutomationRun>;
}

export interface StubAutomationWrites {
  readonly creates: Record<string, unknown>[];
  readonly updates: { ruleId: string; body: Record<string, unknown> }[];
  readonly deletes: string[];
  readonly runs: { ruleId: string; itemId: string | null }[];
  readonly tests: { ruleId: string; itemId: string | null }[];
  readonly runPages: (string | null)[];
}

export const RUN_PAGE_SIZE = 2;

export function automationRule(
  overrides: Partial<StubAutomationRule> & { readonly id: string },
): StubAutomationRule {
  return {
    workspaceId: STUB_WORKSPACE_ID,
    name: 'Weekly review',
    enabled: true,
    scopeItemId: null,
    trigger: { type: 'schedule', freq: 'weekly', interval: 1, weekdays: ['fr'], time: '16:00' },
    conditions: [],
    actions: [{ type: 'notify', title: 'Time for the weekly review', body: '' }],
    revision: 1,
    consecutiveFailures: 0,
    disabledReason: null,
    lastRunAt: null,
    createdAt: '2026-09-30T09:00:00+00:00',
    updatedAt: '2026-09-30T09:00:00+00:00',
    ...overrides,
  };
}

function problem(status: number, code: string, detail: string): Response {
  return json({ title: 'Request failed', status, code, detail }, status);
}

let sequence = 0;
function nextId(): string {
  sequence += 1;
  return `c0000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

export function stubAutomations(options: StubAutomationOptions = {}): StubAutomationWrites {
  const inner = globalThis.fetch;
  let rules = [...(options.rules ?? [])];
  const runs: Record<string, StubAutomationRun[]> = Object.fromEntries(
    Object.entries(options.runs ?? {}).map(([id, list]) => [id, [...list]]),
  );
  let conflictPending = options.conflictOnce ?? false;
  const writes: StubAutomationWrites = {
    creates: [],
    updates: [],
    deletes: [],
    runs: [],
    tests: [],
    runPages: [],
  };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const request = input instanceof Request ? input : null;
      const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
      const path = new URL(url, globalThis.location.origin).pathname;
      const bodyText =
        typeof init?.body === 'string'
          ? init.body
          : request !== null && method !== 'GET'
            ? await request.clone().text()
            : '';
      const body = bodyText === '' ? {} : (JSON.parse(bodyText) as Record<string, unknown>);

      const list = /^\/api\/v1\/workspaces\/([0-9a-f-]{36})\/automations$/.exec(path);
      if (list !== null && method === 'GET') {
        if (options.listFails) return problem(500, 'test.failed', 'The list failed.');
        return json({ items: rules.filter((rule) => rule.workspaceId === list[1]) });
      }
      if (list !== null && method === 'POST') {
        writes.creates.push(body);
        if (options.invalidDetail !== undefined) {
          return problem(422, 'automation.invalid', options.invalidDetail);
        }
        const created = automationRule({
          ...(body as Partial<StubAutomationRule>),
          id: nextId(),
          workspaceId: list[1] ?? STUB_WORKSPACE_ID,
        });
        rules = [...rules, created];
        return json(created, 201);
      }

      const runsPath = /^\/api\/v1\/automations\/([0-9a-f-]{36})\/runs$/.exec(path);
      if (runsPath !== null && method === 'GET') {
        const cursor = new URL(url, globalThis.location.origin).searchParams.get('cursor');
        writes.runPages.push(cursor);
        const all = runs[runsPath[1] ?? ''] ?? [];
        const start = cursor === null ? 0 : Number(cursor);
        const page = all.slice(start, start + RUN_PAGE_SIZE);
        const next = start + RUN_PAGE_SIZE < all.length ? String(start + RUN_PAGE_SIZE) : null;
        return json({ items: page, nextCursor: next });
      }

      const runNow = /^\/api\/v1\/automations\/([0-9a-f-]{36})\/(run|test)$/.exec(path);
      if (runNow !== null && method === 'POST') {
        const ruleId = runNow[1] ?? '';
        const itemId = (body.itemId as string | null | undefined) ?? null;
        if (runNow[2] === 'test') {
          writes.tests.push({ ruleId, itemId });
          return json(options.testResult ?? { wouldRun: true, reason: null, actions: [] });
        }
        writes.runs.push({ ruleId, itemId });
        const run: StubAutomationRun = {
          id: nextId(),
          ruleId,
          itemId,
          origin: 'manual',
          depth: 0,
          status: 'succeeded',
          reason: null,
          createdAt: '2026-09-30T10:00:00+00:00',
          ...options.runResult,
        };
        runs[ruleId] = [run, ...(runs[ruleId] ?? [])];
        return json(run);
      }

      const one = /^\/api\/v1\/automations\/([0-9a-f-]{36})$/.exec(path);
      if (one !== null) {
        const ruleId = one[1] ?? '';
        const stored = rules.find((rule) => rule.id === ruleId);
        if (stored === undefined) {
          return problem(404, 'automation.not_found', 'No automation by that id is visible.');
        }
        if (method === 'GET') return json(stored);
        if (method === 'DELETE') {
          writes.deletes.push(ruleId);
          rules = rules.filter((rule) => rule.id !== ruleId);
          return new Response(null, { status: 204 });
        }
        if (method === 'PUT') {
          writes.updates.push({ ruleId, body });
          if (conflictPending) {
            conflictPending = false;
            rules = rules.map((rule) =>
              rule.id === ruleId
                ? { ...rule, name: `${rule.name} (changed elsewhere)`, revision: rule.revision + 1 }
                : rule,
            );
            return problem(
              409,
              'automation.conflict',
              'This automation changed since you opened it. Reload it before saving.',
            );
          }
          if (options.invalidDetail !== undefined) {
            return problem(422, 'automation.invalid', options.invalidDetail);
          }
          if (body.expectedRevision !== stored.revision) {
            return problem(
              409,
              'automation.conflict',
              'This automation changed since you opened it.',
            );
          }
          const input = body.rule as Partial<StubAutomationRule>;
          const saved: StubAutomationRule = {
            ...stored,
            ...input,
            revision: stored.revision + 1,
            ...(input.enabled === true ? { disabledReason: null, consecutiveFailures: 0 } : {}),
          };
          rules = rules.map((rule) => (rule.id === ruleId ? saved : rule));
          return json(saved);
        }
      }

      return inner(input, init);
    }),
  );

  return writes;
}
