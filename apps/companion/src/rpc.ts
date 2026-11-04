import { spawn, type ChildProcess } from 'node:child_process';
import {
  accessSync,
  closeSync,
  constants,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';

import { MAX_STDERR_BYTES } from './diagnostics.ts';
import type { Notify, RequestHandler, Transport } from './types.ts';
import { isRecord } from './util.ts';

const FEATURES_OFF = [
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
];

/** The exact argument list the Codex app-server is started with. */
export function codexArgs(): string[] {
  const args = [
    'app-server',
    '--listen',
    'stdio://',
    '-c',
    'cli_auth_credentials_store="file"',
    '-c',
    'web_search="disabled"',
    '-c',
    'tools.view_image=false',
    '-c',
    'sandbox_mode="read-only"',
    '-c',
    'approval_policy="on-request"',
    '-c',
    'forced_login_method="chatgpt"',
  ];
  // No ambient user configuration, inherited provider credentials, plugins, or host tools.
  for (const feature of FEATURES_OFF) args.push('-c', `features.${feature}=false`);
  // The pinned runtime dispatches dynamic tools through its code-mode host even when code_mode is
  // disabled; it needs this dispatcher to reach the nix_ tools. Shell, network/browser tools and
  // every other server request remain denied.
  args.push('-c', 'features.code_mode_host=true');
  return args;
}

/** The environment the child gets: no inherited credentials or configuration. */
export function codexEnv(home: string, work: string, trace: boolean): Record<string, string> {
  const env: Record<string, string> = {
    HOME: home,
    CODEX_HOME: home,
    TMPDIR: work,
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
  };
  if (trace) env.RUST_LOG = 'info';
  return env;
}

/** Resolves a bare binary name against this process's PATH, as Go's exec.LookPath does. */
function lookPath(binary: string): string {
  if (binary.includes('/')) return binary;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    try {
      accessSync(join(dir, binary), constants.X_OK);
      return join(dir, binary);
    } catch {
      // keep looking
    }
  }
  return binary;
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

export class Rpc implements Transport {
  private readonly child: ChildProcess;
  private nextId = 0;
  private readonly pending = new Map<string, Pending>();
  private handler: RequestHandler | undefined;
  private stopped = false;
  private readonly exited: Promise<void>;
  private resolveExited!: () => void;

  constructor(child: ChildProcess, notify: Notify) {
    this.child = child;
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
    let buffer = '';
    const out = child.stdout;
    out?.setEncoding('utf8');
    out?.on('data', (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line.trim() !== '' && !this.dispatch(line, notify)) {
          this.stop();
          return;
        }
      }
      // A line over 1 MiB is a protocol violation (bufio.Scanner's token limit).
      if (buffer.length > 1 << 20) this.stop();
    });
    out?.on('end', () => {
      this.stop();
    });
    child.stdin?.on('error', () => undefined);
    child.on('error', () => {
      this.stop();
    });
    child.on('exit', () => {
      this.stop();
    });
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.child.kill('SIGKILL');
    for (const pending of this.pending.values())
      pending.reject(new Error('companion process stopped'));
    this.pending.clear();
    this.resolveExited();
  }

  /** False once the line is not JSON: the stream is then no longer trusted. */
  private dispatch(line: string, notify: Notify): boolean {
    let packet: unknown;
    try {
      packet = JSON.parse(line);
    } catch {
      return false;
    }
    if (!isRecord(packet)) return false;
    const hasId = packet.id !== undefined && packet.id !== null;
    if (typeof packet.method === 'string' && packet.method !== '') {
      if (hasId) {
        const accepted =
          this.handler?.(packet.id, packet.method, packet.params, Buffer.byteLength(line)) ?? false;
        if (!accepted) {
          this.write({
            id: packet.id,
            error: {
              code: -32601,
              message:
                'That tool is not available in this conversation (workspace access may be off).',
            },
          });
        }
      } else {
        notify(packet.method, packet.params);
      }
      return true;
    }
    const pending = this.pending.get(String(packet.id));
    if (pending !== undefined) {
      const failed = packet.error !== undefined && packet.error !== null;
      this.pending.delete(String(packet.id));
      if (failed) pending.reject(new Error('provider refused'));
      else pending.resolve(packet.result);
    }
    return true;
  }

  setRequestHandler(handler: RequestHandler): void {
    this.handler = handler;
  }

  reply(id: unknown, result: unknown): void {
    this.write({ id, result });
  }

  write(value: unknown): void {
    if (this.stopped || this.child.stdin === null || this.child.stdin.destroyed)
      throw new Error('companion process stopped');
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.stopped) return Promise.reject(new Error('companion process stopped'));
    this.nextId++;
    const key = String(this.nextId);
    return new Promise<unknown>((resolve, reject) => {
      const done = (): void => {
        this.pending.delete(key);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        done();
        reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
      };
      this.pending.set(key, {
        resolve: (result) => {
          done();
          resolve(result);
        },
        reject: (error) => {
          done();
          reject(
            new Error(
              error.message === 'provider refused' ? `provider refused ${method}` : error.message,
            ),
          );
        },
      });
      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.write({ id: this.nextId, method, params });
      } catch (error) {
        done();
        reject(error instanceof Error ? error : new Error('write failed'));
      }
    });
  }

  alive(): boolean {
    return !this.stopped;
  }

  close(): void {
    this.child.stdin?.end();
    this.stop();
    void Promise.race([this.exited, new Promise((resolve) => setTimeout(resolve, 3000).unref())]);
  }
}

/**
 * Starts `codex app-server`. With trace on, its stderr (which can contain account data) goes to a
 * private file in the account home instead of being discarded, with info-level provider logging;
 * it never reaches the shared log either way.
 */
export async function launchCodex(
  binary: string,
  home: string,
  notify: Notify,
  trace: boolean,
): Promise<Rpc> {
  const work = join(home, 'empty');
  mkdirSync(work, { recursive: true, mode: 0o700 });
  let stderr: number | 'ignore' = 'ignore';
  if (trace) {
    try {
      mkdirSync(join(home, 'traces'), { recursive: true, mode: 0o700 });
      const path = join(home, 'traces', 'codex-stderr.log');
      try {
        // One generation of rotation keeps the provider log bounded across relaunches.
        if (statSync(path).size > MAX_STDERR_BYTES) renameSync(path, `${path}.1`);
      } catch {
        // no log yet
      }
      stderr = openSync(path, 'a', 0o600);
    } catch {
      stderr = 'ignore';
    }
  }
  const child = spawn(lookPath(binary), codexArgs(), {
    cwd: work,
    env: codexEnv(home, work, trace && stderr !== 'ignore'),
    stdio: ['pipe', 'pipe', stderr],
  });
  if (typeof stderr === 'number') closeSync(stderr);
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const rpc = new Rpc(child, notify);
  try {
    await rpc.call(
      'initialize',
      {
        clientInfo: { name: 'nix_companion', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      },
      AbortSignal.timeout(15_000),
    );
    rpc.write({ method: 'initialized', params: {} });
  } catch (error) {
    rpc.close();
    throw error;
  }
  return rpc;
}
