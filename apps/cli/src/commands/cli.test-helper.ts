import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { vi } from 'vitest';

import { saveProfile, type Profile } from '../config.ts';
import { outputOptions } from '../output.ts';

/** A throwaway config directory holding `profile` as the default profile. */
export async function makeProfile(
  profile: Profile,
): Promise<{ env: NodeJS.ProcessEnv; dir: string; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'nixctl-'));
  const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: dir };
  await saveProfile('default', profile, { makeDefault: true, env });
  return { env, dir, done: () => rm(dir, { recursive: true, force: true }) };
}

/** Everything `body` writes to stdout, as one string. */
export async function captureStdout(body: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  });
  try {
    await body();
  } finally {
    spy.mockRestore();
  }
  return lines.join('');
}

/** What `body` prints in `--json` mode, parsed. */
export async function captureJson(
  body: (json: ReturnType<typeof outputOptions>) => Promise<void>,
): Promise<unknown> {
  return JSON.parse(await captureStdout(() => body(outputOptions(true, { isTTY: false }))));
}

/** What `body` prints in human mode. */
export function captureText(
  body: (json: ReturnType<typeof outputOptions>) => Promise<void>,
  isTTY = false,
): Promise<string> {
  return captureStdout(() => body(outputOptions(false, { isTTY })));
}
