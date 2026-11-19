import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runPetPeer } from './pet-peer-runner.ts';

it.each(['claude', 'codex'] as const)(
  'runs %s in a fresh scratch directory with one named MCP tool',
  async (runtime) => {
    const fixture = await mkdtemp(join(tmpdir(), 'nix-peer-test-'));
    try {
      const executable = join(fixture, 'provider');
      await writeFile(
        executable,
        `#!/usr/bin/env node
      const args = process.argv.slice(2);
      const { env } = process;
      const kind = args[0] === 'exec' ? 'codex' : 'claude';
      const key = kind === 'codex' ? env.CODEX_API_KEY : env.ANTHROPIC_API_KEY;
      if (key !== 'fixture-key' || env.NIX_PET_JOB_CREDENTIAL !== 'nixpeer_fixture-credential'
          || env.OPENAI_API_KEY !== undefined || args.join(' ').includes(key)
          || args.join(' ').includes(env.NIX_PET_JOB_CREDENTIAL)
          || !args.join(' ').includes('pet_job_assignment')) process.exit(2);
      if (kind === 'claude') {
        if (!args.includes('--bare') || !args.includes('--strict-mcp-config')
            || args[args.indexOf('--tools')+1] !== '') process.exit(3);
        console.log(JSON.stringify({ is_error: false, result: 'fixture result' }));
      } else {
        if (!args.includes('--ephemeral') || !args.includes('--ignore-user-config')
            || !args.includes('features.shell_tool=false') || !args.includes('features.view_image=false')
            || args[args.indexOf('--model')+1] !== 'gpt-5.4') process.exit(3);
        console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'fixture result' } }));
      }
      `,
        { mode: 0o700 },
      );
      await expect(
        runPetPeer({
          runtime,
          executable,
          endpoint: new URL(
            'https://nix.example.test/mcp/pets/f77f851f-f415-4866-b783-df01070d2c55',
          ),
          credential: 'nixpeer_fixture-credential',
          apiKey: 'fixture-key',
        }),
      ).resolves.toBe('fixture result');
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
