import { mkdtemp, readFile, stat, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { Command } from 'commander';
import { petPlans } from '@nix/api-client';
import {
  decisionContextPath,
  executePlanDecisionHandoff,
  executePlanDecision,
  readDecisionContext,
  saveDecisionContext,
  registerPetPlanCommands,
  printPlan,
} from './pet-plans.ts';
import { openSession } from '../session.ts';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const planId = '33333333-3333-4333-8333-333333333333';
const contextId = '44444444-4444-4444-8444-444444444444';
const requestId = '55555555-5555-4555-8555-555555555555';
const expiresAt = new Date(Date.now() + 240_000).toISOString();
const privateValue = 'private-context-opaque-value-12345678901234567890';
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const directory = async () => {
  const path = await mkdtemp(join(tmpdir(), 'nix-plan-context-'));
  directories.push(path);
  return path;
};

describe('private exact plan handoffs', () => {
  it('prints complete readable values and receipts unless JSON is explicitly requested', () => {
    const run = petPlans.read(workspaceId, runId).schema.parse({
      id: runId,
      workspaceId,
      petId: contextId,
      brief: 'Append the reviewed text',
      sourceScope: { kind: 'selected', itemIds: [] },
      status: 'completed',
      revision: 4,
      results: [],
      createdAt: expiresAt,
      updatedAt: expiresAt,
      plan: {
        id: planId,
        version: 1,
        summary: 'Append',
        reviewDigest: 'digest',
        scopeDigest: 'scope',
        recipientRevision: 'recipient',
        status: 'completed',
        steps: [
          {
            id: requestId,
            capability: 'workspace.append_note',
            arguments: {},
            effect: { description: 'Append to the brief', parameters: {} },
            executor: 'client',
            status: 'applied',
            fields: [
              {
                id: 'values',
                label: 'Reviewed values',
                kind: 'group',
                required: true,
                value: {
                  emptyList: [],
                  emptyGroup: {},
                  emptyText: '',
                  nothing: null,
                  zero: 0,
                  no: false,
                  literal: '{"example":true}',
                },
              },
            ],
            receipt: '{"changed":true,"count":0}',
            receiptView: {
              summary: 'Applied the change',
              details: {
                changed: true,
                count: 0,
                emptyList: [],
                emptyGroup: {},
                emptyText: '',
                no: false,
                nested: { literal: '{"example":true}' },
              },
            },
          },
        ],
      },
      observations: [
        {
          id: requestId,
          capability: 'workspace.read_item',
          description: 'Read the brief',
          receiptView: {
            summary: 'Read confirmed',
            details: { zero: 0, no: false, nested: [] },
            text: 'Read safely.',
          },
        },
      ],
    });
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    printPlan(run, { json: false, isTty: false });
    const text = chunks.join('');
    expect(text).toContain('emptyList: Empty list');
    expect(text).toContain('emptyGroup: Empty group');
    expect(text).toContain('emptyText: Empty text');
    expect(text).toContain('nothing: Empty value');
    expect(text).toContain('zero: 0');
    expect(text).toContain('no: false');
    expect(text).toContain('{"example":true}');
    expect(text).toContain('changed: true; count: 0');
    expect(text).not.toContain('{"changed":true');
    expect(text).toContain('Applied the change');
    expect(text).toContain('Read the brief');
    expect(text).toContain('Read confirmed');
    expect(text).toContain('Read safely.');
    expect(text).toContain('nested: Empty list');
    const step = run.plan?.steps[0];
    if (!step) throw new Error('Missing test step');
    step.receiptView = undefined;
    chunks.length = 0;
    printPlan(run, { json: false, isTty: false });
    expect(chunks.join('')).toContain('{"changed":true,"count":0}');
    expect(chunks.join('')).not.toContain('changed: true; count: 0');
    chunks.length = 0;
    printPlan(run, { json: true, isTty: false });
    expect(JSON.parse(chunks.join(''))).toEqual(run);
  });
  it('advertises inspection, exact handoff and cancellation without provider start or direct undo', () => {
    const program = new Command();
    registerPetPlanCommands(program, () => Promise.resolve());
    const group = program.commands.find((command) => command.name() === 'pet-plans');
    const names = group?.commands.map((command) => command.name());
    expect(names).toContain('decision-handoff');
    expect(names).toContain('undo-handoff');
    expect(names).not.toContain('start');
    expect(names).not.toContain('undo');
  });

  it('keeps browser-approved CLI credentials on the ordinary browser review path', async () => {
    const session = openSession({
      profile: {
        apiUrl: 'http://core.test',
        token: '',
        interactiveSession: { refreshToken: 'fixture', expiresAt },
      },
    });
    await expect(
      executePlanDecisionHandoff(session, workspaceId, runId, 'Named CLI', true),
    ).rejects.toThrow('Use a PAT profile');
  });
  it('stores secrets in mode 0600 and refuses a public or expired context file', async () => {
    const file = join(await directory(), 'decision.json');
    const value = {
      apiOrigin: 'http://core.test',
      contextId,
      workspaceId,
      runId,
      planId,
      planVersion: 1,
      reviewDigest: 'digest',
      approve: true,
      requestId,
      decisionContext: privateValue,
      expiresAt,
    };
    await saveDecisionContext(file, value);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readDecisionContext(file)).toEqual(value);
    await chmod(file, 0o644);
    await expect(readDecisionContext(file)).rejects.toThrow('private file');
    expect(decisionContextPath(contextId, { XDG_CONFIG_HOME: '/fixture' })).toBe(
      `/fixture/nixctl/plan-decisions/${contextId}.json`,
    );
  });

  it('never forwards a private context to a different profile origin', async () => {
    const file = join(await directory(), 'context.json');
    await saveDecisionContext(file, {
      apiOrigin: 'http://core.test',
      contextId,
      workspaceId,
      runId,
      planId,
      planVersion: 1,
      reviewDigest: 'digest',
      approve: true,
      requestId,
      decisionContext: privateValue,
      expiresAt,
    });
    const fetch = vi.spyOn(globalThis, 'fetch');
    const foreign = openSession({
      profile: { apiUrl: 'http://foreign.test', token: '' },
      bearerToken: 'fixture-owner',
    });
    await expect(executePlanDecision(foreign, file)).rejects.toThrow('another Nix server');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns only a browser handoff ID and saves the received secret without printing it', async () => {
    const root = await directory();
    const server = setupServer(
      http.get(`http://core.test/api/v1/workspaces/${workspaceId}/pet-plans/${runId}`, () =>
        HttpResponse.json({
          id: runId,
          workspaceId,
          anchorItemId: null,
          petId: contextId,
          brief: 'Rename the brief',
          sourceScope: { kind: 'selected', itemIds: [] },
          status: 'waiting_for_approval',
          revision: 4,
          question: null,
          plan: {
            id: planId,
            version: 1,
            summary: 'Rename',
            reviewDigest: 'digest',
            scopeDigest: 'scope',
            recipientRevision: 'recipient',
            status: 'awaiting_review',
            steps: [],
          },
          results: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      ),
      http.post(
        `http://core.test/api/v1/workspaces/${workspaceId}/pet-plans/${runId}/decision-handoffs`,
        async ({ request }) => {
          expect(await request.json()).toEqual({
            planId,
            planVersion: 1,
            reviewDigest: 'digest',
            clientName: 'Named CLI',
            approve: true,
          });
          return HttpResponse.json({
            handoffId: contextId,
            browserPath: `/w/${workspaceId}/pet/plans/${runId}/review?handoffId=${contextId}`,
            decisionContext: privateValue,
            expiresAt,
          });
        },
      ),
    );
    server.listen({ onUnhandledRequest: 'error' });
    try {
      const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const session = openSession({
        profile: { apiUrl: 'http://core.test', token: '' },
        bearerToken: 'fixture-session',
      });
      const result = await executePlanDecisionHandoff(
        session,
        workspaceId,
        runId,
        'Named CLI',
        true,
        { XDG_CONFIG_HOME: root },
      );
      expect(JSON.stringify(result)).not.toContain(privateValue);
      expect(result.browserPath).not.toContain('decisionContext');
      expect(output).not.toHaveBeenCalled();
      const file = decisionContextPath(contextId, { XDG_CONFIG_HOME: root });
      expect(await readFile(file, 'utf8')).toContain(privateValue);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      server.close();
    }
  });
});
