/**
 * `nixctl token rotate <id>`: replaces a personal access token's secret and updates the local
 * profiles that were using the old one.
 *
 * Human-only: Core refuses rotation from a token-authenticated session, so this needs a
 * browser-approved login (`nixctl auth login`), and it is deliberately not an MCP tool.
 */

import { accessTokens } from '@nix/api-client';
import { loadConfig, saveProfile, type Profile } from '../config.ts';
import { printResult, type OutputOptions } from '../output.ts';
import { createPatTokenProvider, type Session } from '../session.ts';
import { resolveSession, type SessionDeps } from './shared.ts';

/** The id of the personal access token a minted session JWT came from, or null. */
function patIdOf(jwt: string | null): string | null {
  try {
    const payload = JSON.parse(
      Buffer.from(jwt?.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { nix_pat_id?: unknown };
    return typeof payload.nix_pat_id === 'string' ? payload.nix_pat_id : null;
  } catch {
    return null;
  }
}

/**
 * Rotates the token, then writes the new secret into every PAT profile on the same server whose
 * old secret belonged to it. Profiles are matched before rotating, by exchanging each one's token
 * and reading the token id out of the session it buys; a profile whose token no longer works is
 * left alone. Secrets are only ever sent to the server they are stored for.
 */
export async function executeRotateToken(
  session: Session,
  tokenId: string,
  deps: SessionDeps = {},
): Promise<Record<string, unknown>> {
  const env = deps.env ?? process.env;
  const config = await loadConfig(env);
  const matching: (readonly [string, Profile])[] = [];
  for (const [name, profile] of Object.entries(config.profiles)) {
    if (profile.token === '' || profile.apiUrl !== session.endpoints.apiUrl) continue;
    const provider = createPatTokenProvider({
      profile,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    });
    try {
      if (patIdOf(await provider.getAccessToken()) === tokenId)
        matching.push([name, profile] as const);
    } catch {
      // A dead or unreachable credential is not this token.
    }
  }

  const rotated = await session.client.execute(accessTokens.rotateAccessToken(tokenId));
  for (const [name, profile] of matching) {
    await saveProfile(name, { ...profile, token: rotated.token }, { env });
  }

  return {
    ...rotated.details,
    token: rotated.token,
    updatedProfiles: matching.map(([name]) => name),
  };
}

export async function rotateToken(
  profileName: string | undefined,
  tokenId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  if (session.authKind === 'token') {
    throw new Error(
      'Rotating a token needs a browser sign-in, not a token. Run `nixctl auth login` and try again.',
    );
  }
  printResult(await executeRotateToken(session, tokenId, deps), output);
}
