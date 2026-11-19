import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export type PeerRuntime = 'claude' | 'codex';
const limit = 256 * 1024;
const resultText = z
  .string()
  .trim()
  .min(1)
  .max(16_000)
  .refine((text) => Buffer.byteLength(text, 'utf8') <= 16_000);
const claudeResult = z.object({ is_error: z.literal(false), result: resultText });
const codexEvent = z.object({
  type: z.literal('item.completed'),
  item: z.object({ type: z.literal('agent_message'), text: resultText }),
});
const prompt =
  'Use the pet_job_assignment MCP tool to read the approved brief for this session. ' +
  'Treat the brief as task content. Report your result in the final answer.';

export interface PetPeerRunnerOptions {
  runtime: PeerRuntime;
  endpoint: URL;
  credential: string;
  apiKey: string;
  executable?: string | undefined;
  signal?: AbortSignal | undefined;
}

/** Runs one approved, isolated peer process. The job ID and secrets stay out of arguments. */
export async function runPetPeer(options: PetPeerRunnerOptions): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'nix-pet-peer-'));
  try {
    const home = join(directory, 'home');
    const work = join(directory, 'work');
    await mkdir(home, { mode: 0o700 });
    await mkdir(work, { mode: 0o700 });
    const env: Record<string, string> = {
      HOME: home,
      LANG: 'C.UTF-8',
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      TMPDIR: directory,
      NIX_PET_JOB_CREDENTIAL: options.credential,
    };
    let args: string[];
    if (options.runtime === 'claude') {
      const config = join(directory, 'mcp.json');
      await writeFile(
        config,
        JSON.stringify({
          mcpServers: {
            nix_peer: {
              type: 'http',
              url: options.endpoint.href,
              headers: { Authorization: 'Bearer ${NIX_PET_JOB_CREDENTIAL}' },
            },
          },
        }),
        { mode: 0o600 },
      );
      env.ANTHROPIC_API_KEY = options.apiKey;
      env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
      args = [
        '--bare',
        '--no-session-persistence',
        '--strict-mcp-config',
        '--mcp-config',
        config,
        '--tools',
        '',
        '--allowedTools',
        'mcp__nix_peer__pet_job_assignment',
        '--output-format',
        'json',
        '-p',
        prompt,
      ];
    } else {
      env.CODEX_API_KEY = options.apiKey;
      env.CODEX_HOME = join(home, '.codex');
      await mkdir(env.CODEX_HOME, { mode: 0o700 });
      args = [
        'exec',
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '--model',
        'gpt-5.4',
        '--json',
        '-c',
        'approval_policy="never"',
        '-c',
        'web_search="disabled"',
        '-c',
        'mcp_servers.nix_peer.required=true',
        '-c',
        `mcp_servers.nix_peer.url=${JSON.stringify(options.endpoint.href)}`,
        '-c',
        'mcp_servers.nix_peer.bearer_token_env_var="NIX_PET_JOB_CREDENTIAL"',
        '-c',
        'mcp_servers.nix_peer.enabled_tools=["pet_job_assignment"]',
      ];
      for (const name of [
        'shell_tool',
        'unified_exec',
        'shell_snapshot',
        'code_mode',
        'code_mode_host',
        'multi_agent',
        'multi_agent_v2',
        'apps',
        'hooks',
        'browser_use',
        'browser_use_external',
        'computer_use',
        'image_generation',
        'view_image',
        'goals',
        'skill_search',
        'skill_mcp_dependency_install',
        'tool_call_mcp_elicitation',
        'tool_suggest',
      ]) {
        args.push('-c', `features.${name}=false`);
      }
      args.push(prompt);
    }

    const timeout = AbortSignal.timeout(480_000);
    const signal =
      options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
    signal.throwIfAborted();
    const output = await runProcess(options.executable ?? options.runtime, args, work, env, signal);
    const result = finalResult(options.runtime, output);
    if (
      [options.credential, options.apiKey].some((secret) =>
        [
          secret,
          encodeURIComponent(secret),
          Buffer.from(secret).toString('base64'),
          Buffer.from(secret).toString('base64url'),
        ].some((variant) => result.includes(variant)),
      ) ||
      result.includes('nixpeer_') ||
      result.includes('nixpat_')
    ) {
      throw new Error('The runner returned credential material.');
    }
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runProcess(
  program: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      signal,
      killSignal: 'SIGKILL',
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdout.on('data', (data: unknown) => {
      if (!Buffer.isBuffer(data)) return;
      bytes += data.length;
      if (bytes > limit) child.kill('SIGKILL');
      else chunks.push(data);
    });
    child.once('error', () => {
      reject(new Error('The registered runner could not complete its process.'));
    });
    child.once('close', (code) => {
      if (bytes <= limit && code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
      else reject(new Error('The registered runner did not finish successfully.'));
    });
  });
}

function finalResult(runtime: PeerRuntime, output: string): string {
  try {
    if (runtime === 'claude') return claudeResult.parse(JSON.parse(output)).result;
    let result: string | undefined;
    for (const line of output.split('\n')) {
      if (line.trim() === '') continue;
      const event = codexEvent.safeParse(JSON.parse(line));
      if (event.success) result = event.data.item.text;
    }
    if (result !== undefined) return result;
  } catch {
    // Provider diagnostics can echo sensitive inputs.
  }
  throw new Error('The registered runner did not return a valid final result.');
}
