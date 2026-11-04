import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Response as CompanionResponse } from './types.ts';
import {
  boot,
  eventually,
  fakeCodexBinary,
  FakeTransport,
  IDS,
  jsonResponse,
  keyOf,
  request,
  SECRET,
  sse,
  startServer,
  type Booted,
  type FakeServer,
} from './testing.ts';

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});
async function up(options: Parameters<typeof boot>[0] = {}): Promise<Booted> {
  const b = await boot(options);
  open.push(b);
  return b;
}
const json = async (response: Response): Promise<CompanionResponse> =>
  (await response.json()) as CompanionResponse;

describe('routes and authentication', () => {
  it('answers 401 with a problem body when the secret is missing, wrong or the wrong length', async () => {
    const b = await up();
    for (const headers of [
      {},
      { 'X-Nix-Internal-Secret': 'wrong' },
      { 'X-Nix-Internal-Secret': `${SECRET}x` },
      { 'X-Nix-Internal-Secret': '' },
    ]) {
      const response = await b.post(request({ operation: 'status' }), headers);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        code: 'internal_auth_required',
        detail: 'A trusted service credential is required.',
      });
    }
    expect(b.fake.calls).toEqual([]);
  });

  it('serves liveness without a secret and readiness only while the data directory is writable and Core answers', async () => {
    const b = await up();
    expect((await fetch(`${b.url}/healthz`)).status).toBe(200);
    expect(await (await fetch(`${b.url}/readyz`)).json()).toEqual({ status: 'ready' });
    const down = await up({ deps: { ping: () => Promise.resolve(false) } });
    expect((await fetch(`${down.url}/readyz`)).status).toBe(503);
    const unwritable = await up({ config: { dataDir: '/nonexistent-companion-dir-xyz' } }).catch(
      () => undefined,
    );
    expect(unwritable).toBeUndefined();
  });

  it('knows only its routes and their methods', async () => {
    const b = await up();
    expect((await fetch(`${b.url}/nope`)).status).toBe(404);
    expect((await fetch(`${b.url}/v1/companion`)).status).toBe(405);
    expect((await fetch(`${b.url}/healthz`, { method: 'POST' })).status).toBe(405);
  });
});

describe('request handling', () => {
  it('answers 400 to bad JSON, unknown fields, unknown operations, trailing content and an oversize body', async () => {
    const b = await up();
    const bad: unknown[] = [
      '{nope',
      { ...request({ operation: 'status' }), surprise: 1 },
      request({ operation: 'command/exec' }),
      `${JSON.stringify(request({ operation: 'status' }))} {}`,
      request({ operation: 'send', text: '' }),
      request({ principalId: 'x' }),
      JSON.stringify({ ...request({ operation: 'status' }), sharedText: 'a'.repeat(1_300_000) }),
    ];
    for (const body of bad) {
      const response = await b.post(body);
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(await response.text()).toBe('Invalid companion request\n');
    }
    expect(b.fake.calls.filter((c) => c.method !== 'account/read')).toEqual([]);
  });

  it('answers a status request with every field of the wire response', async () => {
    const b = await up();
    const response = await b.call({ operation: 'status', workspaceId: '', petId: '' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(Object.keys((await response.json()) as object).sort()).toEqual([
      'canConnect',
      'history',
      'lockedRead',
      'messages',
      'models',
      'provider',
      'reason',
      'revision',
      'state',
      'status',
      'title',
      'tools',
      'userCode',
      'verificationUrl',
    ]);
  });

  it('runs a conversation over HTTP, with a watch that wakes on a change', async () => {
    const b = await up();
    const sent = await json(await b.call({ operation: 'send', workspaceAccess: true }));
    expect(sent).toMatchObject({ state: 'thinking', status: 'connected' });
    const watch = b.call({ operation: 'watch', after: sent.revision });
    setTimeout(() => {
      b.notifications[0]?.('item/agentMessage/delta', {
        threadId: 'provider-thread',
        itemId: 'i',
        delta: 'Hi',
      });
    }, 30);
    const woke = await json(await watch);
    expect(woke.revision).toBeGreaterThan(sent.revision);
    expect(woke.messages.at(-1)?.text).toBe('Hi');
    b.notifications[0]?.('turn/completed', {
      threadId: 'provider-thread',
      turn: { status: 'completed' },
    });
    expect((await json(await b.call({ operation: 'read' }))).state).toBe('success');
  });

  it('serves a second conversation for the same account without relaunching', async () => {
    let launches = 0;
    const b = await up({
      launch: (_p, _b, _h, _k, notify) => {
        launches++;
        b.notifications.push(notify);
        return Promise.resolve(b.fake);
      },
    });
    await b.call({ operation: 'status', workspaceId: '', petId: '' });
    await b.call({ operation: 'models' });
    expect(launches).toBe(1);
  });

  it('answers 409 while another mutating request holds the account, but never for a read or a watch', async () => {
    const b = await up();
    await b.call({ operation: 'status', workspaceId: '', petId: '' });
    let release: () => void = () => undefined;
    b.fake.script = (method) =>
      method === 'model/list'
        ? new Promise((resolve) => {
            release = () => {
              resolve({ data: [] });
            };
          })
        : undefined;
    const slow = b.call({ operation: 'models' });
    await eventually(() => b.fake.methods().includes('model/list'));
    const refused = await b.call({ operation: 'send' });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toBe('Companion is busy\n');
    expect((await b.call({ operation: 'read' })).status).toBe(200);
    expect((await b.call({ operation: 'watch', after: 0 })).status).toBe(200);
    release();
    expect((await slow).status).toBe(200);
    expect((await b.call({ operation: 'send' })).status).toBe(200);
    expect(b.logger.lines.some((l) => l.message === 'companion request.busy')).toBe(true);
  });

  it('caps open watches per account at 4 with a 429', async () => {
    const b = await up();
    const sent = await json(await b.call({ operation: 'send' }));
    const controller = new AbortController();
    const watches = Array.from({ length: 4 }, () =>
      b
        .call({ operation: 'watch', after: sent.revision + 1_000_000 }, controller.signal)
        .catch(() => undefined),
    );
    await eventually(() => [...b.manager.accounts.values()].some((a) => a.watchers === 4));
    const refused = await b.call({ operation: 'watch', after: sent.revision + 1_000_000 });
    expect(refused.status).toBe(429);
    expect(await refused.text()).toBe('Too many open watches\n');
    controller.abort();
    await Promise.all(watches);
    await eventually(() => [...b.manager.accounts.values()].every((a) => a.watchers === 0));
    expect((await b.call({ operation: 'watch', after: 0 })).status).toBe(200);
  });

  it('maps replace failures to 400 and 409, and other failures to 502', async () => {
    const b = await up();
    await b.call({ operation: 'send' });
    const busy = await b.call({
      operation: 'send',
      requestId: IDS.other,
      replaceFromMessageId: IDS.item,
    });
    expect(busy.status).toBe(409);
    b.notifications[0]?.('turn/completed', {
      threadId: 'provider-thread',
      turn: { status: 'completed' },
    });
    const target = await b.call({
      operation: 'send',
      requestId: IDS.other,
      replaceFromMessageId: IDS.item,
    });
    expect(target.status).toBe(400);
    b.fake.script = (method) =>
      method === 'model/list' ? new Error('provider refused model/list') : undefined;
    const failed = await b.call({ operation: 'models' });
    expect(failed.status).toBe(502);
    expect(await failed.text()).toBe('Companion request failed; reconnect or retry\n');
    expect(failed.headers.get('x-nix-provider-error')).toBeNull();
  });

  it('answers 503 and logs the cause when the runtime cannot start, and at the account cap', async () => {
    const b = await up({ launch: () => Promise.reject(new Error('spawn codex ENOENT')) });
    const response = await b.call({ operation: 'status', workspaceId: '', petId: '' });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Companion runtime unavailable\n');
    expect(
      b.logger.lines.find((l) => l.message === 'companion runtime unavailable')?.attrs,
    ).toMatchObject({ operation: 'status', error: 'spawn codex ENOENT' });
    const capped = await up();
    for (let i = 0; i < 4; i++) {
      expect(
        (
          await capped.call({
            operation: 'status',
            workspaceId: '',
            petId: '',
            principalId: `99999999-9999-4999-8999-99999999999${String(i)}`,
          })
        ).status,
      ).toBe(200);
    }
    expect((await capped.call({ operation: 'status', workspaceId: '', petId: '' })).status).toBe(
      503,
    );
  });

  it('starts an account once when requests race, and relaunches a dead one', async () => {
    let launches = 0;
    const fake = new FakeTransport();
    const b = await up({
      fake,
      launch: async () => {
        launches++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return fake;
      },
    });
    await Promise.all([
      b.call({ operation: 'status', workspaceId: '', petId: '' }),
      b.call({ operation: 'status', workspaceId: '', petId: '' }),
    ]);
    expect(launches).toBe(1);
    (fake as FakeTransport & { alive?: () => boolean }).alive = () => false;
    await b.call({ operation: 'status', workspaceId: '', petId: '' });
    expect(launches).toBe(2);
  });
});

describe('providers over HTTP', () => {
  let provider: FakeServer | undefined;
  afterEach(async () => {
    await provider?.close();
    provider = undefined;
  });

  it('answers 502 with the provider code header for a rejected key, and keeps accounts per provider', async () => {
    provider = await startServer((_seen, res) => {
      jsonResponse(res, 401, { error: { message: 'private' } });
    });
    const b = await up({ real: true, deps: { providerBaseUrls: { anthropic: provider.url } } });
    const response = await b.call({ operation: 'models', provider: 'anthropic', apiKey: 'sk-bad' });
    expect(response.status).toBe(502);
    expect(response.headers.get('x-nix-provider-error')).toBe('anthropic.authentication.401');
    expect(await response.text()).toBe('Companion request failed; reconnect or retry\n');
    expect(b.manager.accounts.size).toBe(1);
    expect([...b.manager.accounts.keys()][0]).toBe(`${IDS.tenant}-${IDS.principal}-anthropic`);
  });

  it('lets a later request replace the in-memory key, and keeps it out of the logs', async () => {
    provider = await startServer((seen, res) => {
      if (seen.headers['x-api-key'] === 'sk-good')
        return jsonResponse(res, 200, { data: [{ id: 'claude-x' }] });
      jsonResponse(res, 401, {});
    });
    const b = await up({ real: true, deps: { providerBaseUrls: { anthropic: provider.url } } });
    expect(
      (await b.call({ operation: 'models', provider: 'anthropic', apiKey: 'sk-bad' })).status,
    ).toBe(502);
    const ok = await json(
      await b.call({ operation: 'models', provider: 'anthropic', apiKey: 'sk-good' }),
    );
    expect(ok.models.map((m) => m.id)).toEqual(['claude-x']);
    expect(b.logger.text()).not.toContain('sk-');
  });

  it('reports a key provider without a key as disconnected', async () => {
    provider = await startServer((_seen, res) => {
      jsonResponse(res, 200, { data: [] });
    });
    const b = await up({ real: true, deps: { providerBaseUrls: { anthropic: provider.url } } });
    const status = await json(
      await b.call({ operation: 'status', provider: 'anthropic', workspaceId: '', petId: '' }),
    );
    expect(status).toMatchObject({
      status: 'disconnected',
      reason: 'Add an API key for this provider in Settings > Pets.',
      provider: 'anthropic',
    });
  });

  it('runs a whole key-provider turn, watched to completion', async () => {
    provider = await startServer((seen, res) => {
      if (seen.url.startsWith('/v1/models'))
        return jsonResponse(res, 200, { data: [{ id: 'claude-x' }] });
      sse(res, [
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
        { type: 'message_stop' },
      ]);
    });
    const b = await up({ real: true, deps: { providerBaseUrls: { anthropic: provider.url } } });
    const sent = await json(
      await b.call({ operation: 'send', provider: 'anthropic', apiKey: 'sk-x' }),
    );
    let latest = sent;
    await eventually(() => latest.state !== 'thinking', 3000).catch(() => undefined);
    for (let i = 0; i < 20 && latest.state === 'thinking'; i++) {
      latest = await json(
        await b.call({
          operation: 'watch',
          after: latest.revision,
          provider: 'anthropic',
          apiKey: 'sk-x',
        }),
      );
    }
    expect(latest).toMatchObject({ state: 'success' });
    expect(latest.messages.at(-1)?.text).toBe('Done.');
  });
});

describe('the real Codex launcher', () => {
  it('starts the app server with the exact flags and a bare environment, and runs a turn', async () => {
    const b = await up({ real: true, config: { binary: fakeCodexBinary(), chatEffort: 'low' } });
    const sent = await json(await b.call({ operation: 'send', text: 'hello' }));
    expect(sent.status).toBe('connected');
    const home = join(b.config.dataDir, `${IDS.tenant}-${IDS.principal}`);
    const launch = JSON.parse(readFileSync(join(home, 'launch.json'), 'utf8')) as {
      args: string[];
      env: Record<string, string>;
      cwd: string;
    };
    expect(launch.args.slice(0, 3)).toEqual(['app-server', '--listen', 'stdio://']);
    const flags = launch.args.filter((_, i) => launch.args[i - 1] === '-c');
    expect(flags).toEqual([
      'cli_auth_credentials_store="file"',
      'web_search="disabled"',
      'tools.view_image=false',
      'sandbox_mode="read-only"',
      'approval_policy="on-request"',
      'forced_login_method="chatgpt"',
      ...[
        'shell_tool',
        'unified_exec',
        'shell_snapshot',
        'code_mode',
        'multi_agent',
        'multi_agent_v2',
        'apps',
        'hooks',
        'browser_use',
        'computer_use',
        'image_generation',
        'skill_search',
        'skill_mcp_dependency_install',
        'tool_suggest',
      ].map((f) => `features.${f}=false`),
      'features.code_mode_host=true',
    ]);
    expect(launch.args).toHaveLength(3 + flags.length * 2);
    // Only the five variables the launcher sets, plus what the shell wrapper adds on its own.
    expect(
      Object.keys(launch.env)
        .filter((k) => !['PWD', 'SHLVL', '_', 'OLDPWD', '__CF_USER_TEXT_ENCODING'].includes(k))
        .sort(),
    ).toEqual(['CODEX_HOME', 'HOME', 'LANG', 'PATH', 'TMPDIR']);
    expect(launch.env).toMatchObject({
      HOME: home,
      CODEX_HOME: home,
      TMPDIR: join(home, 'empty'),
      PATH: '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
    });
    expect(launch.env.RUST_LOG).toBeUndefined();
    expect(launch.cwd.endsWith('/empty')).toBe(true);
    await eventually(() => b.manager.accounts.size === 1);
    let latest = sent;
    for (let i = 0; i < 20 && latest.state === 'thinking'; i++)
      latest = await json(
        await b.call({ operation: 'watch', after: latest.revision, text: 'hello' }),
      );
    expect(latest.state).toBe('success');
    expect(latest.messages.at(-1)?.text).toBe('echo: hello');
    // The provider's stderr is discarded unless tracing.
    expect(readdirSync(home)).not.toContain('traces');
  });

  it('routes a provider tool call through approval and answers it', async () => {
    const b = await up({ real: true, config: { binary: fakeCodexBinary() } });
    const sent = await json(
      await b.call({ operation: 'send', text: 'tool', workspaceAccess: true }),
    );
    await eventually(() => b.manager.accounts.size === 1);
    let latest = sent;
    for (let i = 0; i < 20 && latest.tools.length === 0; i++)
      latest = await json(
        await b.call({
          operation: 'watch',
          after: latest.revision,
          text: 'tool',
          workspaceAccess: true,
        }),
      );
    expect(latest.tools).toMatchObject([{ id: 'call-1', status: 'pending' }]);
    await b.call({ operation: 'tool_claim', toolId: 'call-1', requestId: IDS.other });
    await b.call({
      operation: 'tool_result',
      toolId: 'call-1',
      requestId: IDS.other,
      toolResult: 'note text',
      toolSuccess: true,
    });
    for (let i = 0; i < 20 && latest.state === 'thinking'; i++)
      latest = await json(
        await b.call({
          operation: 'watch',
          after: latest.revision,
          text: 'tool',
          workspaceAccess: true,
        }),
      );
    expect(latest.state).toBe('success');
    expect(latest.messages.at(-1)?.text).toContain('note text');
  });

  it('answers a request the provider should not make with a JSON-RPC refusal and keeps the turn alive', async () => {
    const b = await up({ real: true, config: { binary: fakeCodexBinary() } });
    await b.call({ operation: 'send', text: 'tool-forbidden', workspaceAccess: true });
    await eventually(() => b.manager.accounts.size === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await json(await b.call({ operation: 'read', text: 'x' }))).tools).toEqual([]);
  });

  it('notices a provider process that died and starts a fresh one on the next request', async () => {
    const b = await up({ real: true, config: { binary: fakeCodexBinary() } });
    await b.call({ operation: 'send', text: 'crash' });
    const [dead] = [...b.manager.accounts.values()];
    await eventually(() => dead?.transport.alive?.() === false);
    await expect(dead?.transport.call('account/read', {})).rejects.toThrow(
      'companion process stopped',
    );
    expect((await b.call({ operation: 'status', workspaceId: '', petId: '' })).status).toBe(200);
    const [fresh] = [...b.manager.accounts.values()];
    expect(fresh).not.toBe(dead);
    expect(fresh?.transport.alive?.()).toBe(true);
  });

  it('answers 503 when the binary does not exist', async () => {
    const b = await up({ real: true, config: { binary: '/nonexistent/codex' } });
    const response = await b.call({ operation: 'status', workspaceId: '', petId: '' });
    expect(response.status).toBe(503);
  });

  it('interrupts a running turn', async () => {
    const b = await up({ real: true, config: { binary: fakeCodexBinary() } });
    await b.call({ operation: 'send', text: 'hang' });
    const stopped = await json(await b.call({ operation: 'interrupt' }));
    expect(stopped.state === 'thinking' || stopped.state === 'idle').toBe(true);
    let latest = stopped;
    for (let i = 0; i < 20 && latest.state === 'thinking'; i++)
      latest = await json(await b.call({ operation: 'watch', after: latest.revision }));
    expect(latest.state).toBe('idle');
  });
});

describe('idle reaping', () => {
  it('stops a process idle past the configured time, and keeps a busy or recent one', async () => {
    const closed: string[] = [];
    const b = await up({ config: { idleSeconds: 1 }, deps: { reapIntervalMs: 1_000_000 } });
    b.fake.close = () => {
      closed.push('closed');
    };
    await b.call({ operation: 'status', workspaceId: '', petId: '' });
    const [account] = [...b.manager.accounts.values()];
    if (account === undefined) throw new Error('no account');
    b.manager.reap();
    expect(b.manager.accounts.size).toBe(1);
    account.last = Date.now() - 5000;
    account.opBusy = true;
    b.manager.reap();
    expect(b.manager.accounts.size).toBe(1);
    account.opBusy = false;
    b.manager.reap();
    expect(b.manager.accounts.size).toBe(0);
    expect(closed).toEqual(['closed']);
    // The next request starts it again.
    expect((await b.call({ operation: 'status', workspaceId: '', petId: '' })).status).toBe(200);
    expect(b.manager.accounts.size).toBe(1);
  });

  it('keeps an account whose turn is still running', async () => {
    const b = await up({ config: { idleSeconds: 1 }, deps: { reapIntervalMs: 1_000_000 } });
    await b.call({ operation: 'send' });
    const [account] = [...b.manager.accounts.values()];
    if (account === undefined) throw new Error('no account');
    account.last = Date.now() - 60_000;
    b.manager.reap();
    expect(b.manager.accounts.size).toBe(1);
    expect(keyOf(request())).toBeTruthy();
    // A turn stuck past the 15-minute expiry no longer holds the slot.
    for (const c of account.conversations.values()) c.timing.started -= 16 * 60 * 1000;
    b.manager.reap();
    expect(b.manager.accounts.size).toBe(0);
  });
});
