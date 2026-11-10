import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { petEval } from './pet-eval.ts';

const CORE = 'http://nix.eval.test';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const PET = '33333333-3333-4333-8333-333333333333';
const OUTPUT = { json: true, isTty: false };
const blueprint = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../../packages/structure-spec/fixtures/blueprints/reading-log.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as unknown;

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
  process.exitCode = 0;
});
afterAll(() => {
  server.close();
});

function tool(id: string, operation: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    arguments: JSON.stringify({ operation, ...extra }),
    status: 'pending',
    result: '',
    claimId: '',
  };
}

function connection(extra: Record<string, unknown> = {}) {
  return {
    provider: 'chatgpt',
    status: 'connected',
    reason: '',
    canConnect: false,
    ...extra,
  };
}

async function run(scenario = 'reading-log') {
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  await petEval(
    undefined,
    { suite: 'design', scenario, apiUrl: CORE, workspace: WORKSPACE, pet: PET },
    OUTPUT,
    { env: { NIX_SESSION_TOKEN: 'session' }, sleep: () => Promise.resolve() },
  );
  return JSON.parse(lines.join('')) as {
    outcome: string;
    gate: boolean;
    score: { total: number; criteria: { id: string; score: number }[] };
    report: { ok: boolean; problems: { code: string }[] };
    answersSent: number;
    rawToolBytes: number;
  }[];
}

describe('pet eval', () => {
  it('answers a scripted question, captures a blueprint and declines the build', async () => {
    const calls: Record<string, unknown>[] = [];
    const build = tool('build-1', 'build_blueprint', { specJson: JSON.stringify(blueprint) });
    let reads = 0;
    server.use(
      http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        calls.push(body);
        if (body.operation === 'read') {
          reads += 1;
          if (reads === 1)
            return HttpResponse.json(
              connection({
                messages: [{ id: 'q-1', role: 'assistant', text: 'What is your goal?' }],
              }),
            );
          return HttpResponse.json(connection({ tools: [build] }));
        }
        if (body.operation === 'tool_claim')
          return HttpResponse.json(
            connection({ tools: [{ ...build, status: 'claimed', claimId: body.requestId }] }),
          );
        return HttpResponse.json(connection());
      }),
    );
    const [result] = await run();
    expect(result).toMatchObject({ outcome: 'blueprint', gate: true, answersSent: 1 });
    expect(result?.rawToolBytes).toBe(Buffer.byteLength(build.arguments, 'utf8'));
    expect(calls.filter((call) => call.operation === 'send').map((call) => call.text)).toEqual([
      'I want to track books I read, keep notes and maintain a reading habit.',
      'I want a yearly book target.',
    ]);
    expect(calls.find((call) => call.operation === 'tool_result')).toMatchObject({
      toolResult: 'Evaluation run: not building.',
      toolSuccess: false,
    });
    expect(calls.filter((call) => call.operation === 'reset')).toHaveLength(2);
    expect(calls.every((call) => call.mode === '')).toBe(true);
    expect(calls.find((call) => call.operation === 'send')).toMatchObject({ model: '' });
  });

  it('scores the captured blueprint and records criterion scores', async () => {
    const build = tool('build-1', 'build_blueprint', { specJson: JSON.stringify(blueprint) });
    server.use(
      http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        if (body.operation === 'read') return HttpResponse.json(connection({ tools: [build] }));
        if (body.operation === 'tool_claim')
          return HttpResponse.json(
            connection({ tools: [{ ...build, status: 'claimed', claimId: body.requestId }] }),
          );
        return HttpResponse.json(connection());
      }),
    );
    const [result] = await run();
    expect(result?.score.total).toBeGreaterThan(0);
    expect(result?.score.criteria.find((criterion) => criterion.id === 'validator')?.score).toBe(
      20,
    );
    expect(process.exitCode).toBe(0);
  });

  it('declines a build with problems once, listing them, then scores the corrected build', async () => {
    const calls: Record<string, unknown>[] = [];
    const broken = tool('build-1', 'build_blueprint', { specJson: JSON.stringify({ version: 1 }) });
    const build = tool('build-2', 'build_blueprint', { specJson: JSON.stringify(blueprint) });
    let reads = 0;
    server.use(
      http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        calls.push(body);
        if (body.operation === 'read') {
          reads += 1;
          return HttpResponse.json(connection({ tools: [reads === 1 ? broken : build] }));
        }
        if (body.operation === 'tool_claim') {
          const claimedTool = body.toolId === broken.id ? broken : build;
          return HttpResponse.json(
            connection({ tools: [{ ...claimedTool, status: 'claimed', claimId: body.requestId }] }),
          );
        }
        return HttpResponse.json(connection());
      }),
    );
    const [result] = await run();
    expect(result).toMatchObject({ outcome: 'blueprint', gate: true });
    const declined = calls.find(
      (call) => call.operation === 'tool_result' && call.toolId === 'build-1',
    );
    expect(declined?.toolSuccess).toBe(false);
    expect(String(declined?.toolResult)).toMatch(/^Declined: the design has problems\.\n.*title/s);
    expect(calls.filter((call) => call.operation === 'tool_result')).toHaveLength(2);
  });

  it('stops after eight scripted answers', async () => {
    let question = 0;
    const calls: Record<string, unknown>[] = [];
    server.use(
      http.post(`${CORE}/api/v1/me/pets/runtime`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        calls.push(body);
        if (body.operation === 'read') {
          question += 1;
          return HttpResponse.json(
            connection({
              messages: [
                {
                  id: `q-${String(question)}`,
                  role: 'assistant',
                  text: 'Any other goal?',
                },
              ],
            }),
          );
        }
        return HttpResponse.json(connection());
      }),
    );
    const [result] = await run();
    expect(result).toMatchObject({ outcome: 'turn_limit', gate: false, answersSent: 8 });
    expect(result?.report.problems[0]?.code).toBe('eval.no_blueprint');
    expect(calls.filter((call) => call.operation === 'send')).toHaveLength(9);
    expect(calls.filter((call) => call.operation === 'reset')).toHaveLength(2);
    expect(process.exitCode).toBe(1);
  });
});
