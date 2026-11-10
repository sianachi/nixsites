import { createDirectCollabClient, createNixClient, NixApiError } from '@nix/api-client';
import {
  createCompanionBodies,
  defaultIds,
  runWorkspaceTool,
  WorkspaceToolRefusal,
  type CompanionClock,
  type CompanionPorts,
} from '@nix/companion';
import type { CompanionConfig } from '../core/config.ts';

export interface ServerToolInput {
  /** Core's turn token. Lives in this call only; never logged or stored. */
  token: string;
  workspaceId: string;
  args: string;
  timeZone: string;
  scope?: { rootItemId: string; readOnly: boolean };
  toolId: string;
  claimId: string;
  /** The preview fingerprint an approved write must still match (A3). */
  fence?: string;
}

export type ServerToolOutcome =
  | { kind: 'result'; text: string; success: boolean; lockedContent: boolean; image: string }
  // leave the call pending for the app; `stopToken` when Core refused the token (401/429)
  | { kind: 'app'; stopToken?: true };

export interface ServerTools {
  mode: 'reads' | 'all';
  /** `write` is an approved write: it never returns `app`, a refusal is a failed result. */
  run(input: ServerToolInput, signal: AbortSignal, write?: boolean): Promise<ServerToolOutcome>;
}

/** Thrown by the files port: file items are read by the app, which can decode them. */
class NeedsApp extends Error {}

/** The error codes after which the browser may still succeed (an unlock, a fresh session). */
const APP_CODES = new Set([
  'auth.insufficient_scope',
  'items.locked',
  'workspaces.locked',
  'client.network',
  'client.timeout',
]);

/** The owner's zone, not the host's; an unknown zone falls back to UTC. */
export function ownerClock(timeZone: string): CompanionClock {
  let zone = timeZone;
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-CA', { timeZone: zone });
  } catch {
    zone = 'UTC';
    format = new Intl.DateTimeFormat('en-CA', { timeZone: zone });
  }
  return { today: () => format.format(new Date()), timeZone: () => zone, now: () => new Date() };
}

/** The longest a server read runs (account.ts aborts at this), so the token must outlive it. */
export const SERVER_READ_MS = 90_000;
/** shortcut: an approved write stops at 60 s so its 2-minute token still has a margin, upgrade if writes need longer. */
export const SERVER_WRITE_MS = 60_000;

/**
 * False unless the token outlives a whole read plus 30 seconds. Core counts every failed validation against the
 * caller's address, and all users' server reads share the companion's one address.
 */
export function tokenUsable(token: string, now = Date.now(), runMs = SERVER_READ_MS): boolean {
  try {
    const payload = token.split('.')[1] ?? '';
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof exp === 'number' && exp * 1000 - now > runMs + 30_000;
  } catch {
    return false;
  }
}

export function createServerTools(config: CompanionConfig): ServerTools | undefined {
  if (config.serverTools === 'off') return undefined;
  return {
    mode: config.serverTools,
    async run(input, signal, write = false) {
      // A write has no app fallback, so the outcomes that would hand a read back become failures.
      const fallback: ServerToolOutcome = write
        ? {
            kind: 'result',
            text: 'Nix refused the approval, so nothing changed. Ask the owner to approve the request again.',
            success: false,
            lockedContent: false,
            image: '',
          }
        : { kind: 'app' };
      if (!tokenUsable(input.token, Date.now(), write ? SERVER_WRITE_MS : SERVER_READ_MS))
        return fallback;
      // A 401 surfaces; the turn token is never refreshed.
      const tokens = {
        getAccessToken: () => input.token,
        refreshAccessToken: () => Promise.resolve(null),
      };
      const collab = createDirectCollabClient({ baseUrl: config.collabUrl, tokens });
      const ports: CompanionPorts = {
        core: createNixClient({ baseUrl: config.apiUrl, tokens }),
        collab,
        bodies: createCompanionBodies(collab),
        clock: ownerClock(input.timeZone),
        ids: defaultIds(),
        files: {
          read() {
            throw new NeedsApp();
          },
        },
      };
      try {
        const out = await runWorkspaceTool(ports, input.workspaceId, input.args, signal, {
          toolId: input.toolId,
          claimId: input.claimId,
          ...(input.fence === undefined ? {} : { fence: input.fence }),
          ...(input.scope === undefined ? {} : { scope: input.scope }),
        });
        return {
          kind: 'result',
          text: out.text,
          success: true,
          lockedContent: out.lockedContent,
          image: out.image ?? '',
        };
      } catch (error) {
        if (error instanceof NeedsApp) return fallback;
        if (error instanceof NixApiError && (error.status === 401 || error.status === 429))
          return write ? fallback : { kind: 'app', stopToken: true };
        // A dropped connection may have landed a write: it takes the uncertain text below.
        if (
          error instanceof NixApiError &&
          APP_CODES.has(error.code) &&
          !(write && error.code.startsWith('client.'))
        )
          return fallback;
        if (error instanceof WorkspaceToolRefusal)
          return {
            kind: 'result',
            text: error.message,
            success: false,
            lockedContent: error.lockedContent,
            image: '',
          };
        return {
          kind: 'result',
          text: 'The operation failed or its result is uncertain. Inspect Nix before retrying a write. Do not assume success.',
          success: false,
          lockedContent: false,
          image: '',
        };
      }
    },
  };
}
