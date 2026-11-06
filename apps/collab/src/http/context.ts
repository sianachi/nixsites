import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

import type { CoreClient } from '../core/client.ts';
import type { TenantScope } from '../db/tenant-scope.ts';
import type { RateWindow } from '../documents/limits.ts';
import type { ImportBodyService } from '../imports/bodies.ts';
import type { CollabMetrics } from '../metrics.ts';
import type { TemplateImportBodyService } from '../template-imports/bodies.ts';
import type { TemplateService } from '../templates/service.ts';
import type { SessionHub } from '../ws/server.ts';
import type { SessionAuthenticator } from '../ws/session-auth.ts';
import type { ConversationBodyAuthorizer } from './routes/conversation-bodies.ts';
import type { PublicLinkCore } from './routes/public-links.ts';
import { requestToken } from './auth.ts';
import { isUuid } from './params.ts';
import { problem } from './replies.ts';

export interface ServerDependencies {
  readonly pool: Pool;

  /**
   * The one authenticate-and-authorize path, shared by the HTTP endpoints and the socket
   * handshake so there is a single cache and a single behaviour to reason about.
   */
  readonly sessions: SessionAuthenticator;

  /**
   * Core's public surface, for the export routes.
   *
   * An export needs an item's title, its children and their schemas - none of which live in the
   * content tables this service owns. It reads them as the caller, with the caller's token, so an
   * export can never contain more than the person asking for it may see.
   */
  readonly core: CoreClient;

  /**
   * The shared secret that says *which service* is calling the internal surface.
   *
   * Paired with the caller's forwarded token, or a running conversation turn reauthorized
   * through Core. The secret alone never authorizes a body read.
   */
  readonly internalSecret: string;
  readonly conversationBodyAuthorizer?: ConversationBodyAuthorizer;
  readonly publicLinkCore?: PublicLinkCore;

  /** Injected so an export of unchanged content is byte-identical to the last one. */
  readonly now?: (() => Date) | undefined;

  /** How often a live socket's authorization is re-checked. */
  readonly reauthMs?: number | undefined;
  readonly rateWindow?: RateWindow | undefined;
  readonly newDocId?: (() => string) | undefined;
  readonly metrics?: CollabMetrics | undefined;
  readonly templates?: TemplateService | undefined;
  readonly importBodies?: ImportBodyService | undefined;
  readonly templateImportBodies?: TemplateImportBodyService | undefined;

  /** The document layer behind the sockets. Defaults to the handshake-only hub. */
  readonly hub?: SessionHub | undefined;

  /**
   * Told the tenant scope of every request this process successfully authorized.
   *
   * The retention sweep (`documents/retention.ts`, started from `index.ts`) has no way of its
   * own to enumerate tenants - row-level security means a per-tenant connection cannot see past
   * its own tenant, and this service holds no role that bypasses it. This is the one choke
   * point every authorized request already passes through, so it is the cheapest place to
   * remember which tenants this process has actually seen documents for. Optional, and a no-op
   * when omitted: nothing here depends on it being wired up.
   */
  readonly onTenantSeen?: ((scope: TenantScope) => void) | undefined;
}

/** What the route modules receive: the server's dependencies with its defaults resolved. */
export interface RouteDependencies extends ServerDependencies {
  readonly rateWindow: RateWindow;
  readonly newDocId: () => string;
  readonly hub: SessionHub;
}

export interface RequestContext {
  /** The caller's bearer token, for routes that act on Core as the caller. */
  readonly token: string;
  readonly itemId: string;
  readonly workspaceId: string;
  readonly canWrite: boolean;
  readonly bodyKind: string;
  readonly scope: { tenantId: string; principalId: string };
}

/**
 * Tells a document open on this server that a write just committed to its log, so the people
 * editing it see the change now. Best-effort: the write is durable and the session would still
 * pick it up at its next flush, so a failure here is logged rather than turned into a refusal of a
 * write that succeeded.
 */
export async function refreshResident(
  request: FastifyRequest,
  deps: RouteDependencies,
  itemId: string,
): Promise<void> {
  try {
    await deps.hub.refresh?.(itemId);
  } catch (error) {
    request.log.warn({ err: error, itemId }, 'Could not bring the open document up to date.');
  }
}

/**
 * Authenticates, then authorizes, then produces the tenant scope the work runs under.
 *
 * Writes the refusal onto the reply and returns null when either step fails, so callers
 * branch once. **The tenant is Core's answer, never the request's** - a client-supplied
 * tenant would be a second source of truth for the fact the isolation policies stand on.
 */
export async function establish(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: ServerDependencies,
): Promise<RequestContext | null> {
  const token = requestToken(request, reply);
  if (token === null) {
    return null;
  }

  const { itemId } = request.params as { itemId: string };
  if (!isUuid(itemId)) {
    // Not-found rather than a validation error, to match Core: a malformed identifier and
    // an identifier for something the caller may not see get the same answer.
    problem(reply, 404, 'document_not_found', 'No such item.');
    return null;
  }

  const result = await deps.sessions.authenticate(token, itemId);
  if (!result.ok) {
    if (result.reason === 'unauthenticated') {
      problem(reply, 401, 'unauthenticated', 'The token could not be validated.');
    } else if (result.reason === 'locked') {
      problem(reply, 403, 'body_locked', "This item's body is locked. Unlock it first.");
    } else if (result.reason === 'unavailable') {
      void reply.header('retry-after', '5');
      problem(reply, 503, 'authorization_unavailable', 'Access could not be confirmed. Retry.');
    } else {
      problem(reply, 404, 'document_not_found', 'No such item.');
    }
    return null;
  }

  const authorization = result.value;
  const scope = { tenantId: authorization.tenantId, principalId: authorization.principalId };
  deps.onTenantSeen?.(scope);

  return {
    token,
    itemId,
    workspaceId: authorization.workspaceId,
    canWrite: authorization.canWrite,
    bodyKind: authorization.bodyKind,
    scope,
  };
}
