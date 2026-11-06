import { isRecord, rejectAllSuggestions } from '@nix/editor-schema';
import { createLossReport } from '@nix/export';
import { renderProse } from '@nix/site-render/prose';
import type { FastifyInstance } from 'fastify';

import { findDocByItem } from '../../db/documents.ts';
import { withTenantScope, type TenantScope } from '../../db/tenant-scope.ts';
import { noteStrategy, strategyFor } from '../../documents/body-kinds.ts';
import { loadDocument } from '../../documents/service.ts';
import { internalCaller } from '../auth.ts';
import type { RouteDependencies } from '../context.ts';
import { isUuid } from '../params.ts';
import { problem } from '../replies.ts';

/**
 * Anonymous note reads (ADR-0068). The shared secret only says which service is calling: the body
 * is read, and every file named in it is classified, on Core's answer for this exact link.
 */

/** Core's view of a file named by a note; "hidden" covers every reason a reader may not know it. */
export type FileDisposition = 'servable' | 'withheld' | 'hidden';

export interface FileVerdict {
  readonly id: string;
  readonly disposition: FileDisposition;
  /** Set for servable and withheld files only. */
  readonly name: string | null;
  readonly mediaType: string | null;
}

export interface LinkScope extends TenantScope {
  linkId: string;
  workspaceId: string;
  itemId: string;
}

export interface PublicLinkCore {
  authorize(scope: LinkScope): Promise<{ title: string; bodyKind: string } | 'unavailable' | null>;
  files(
    scope: LinkScope,
    request: { blocks: string[]; images: string[] },
  ): Promise<{ blocks: FileVerdict[]; images: FileVerdict[] } | 'unavailable' | null>;
}

/** Core swaps the sentinel for the link's token; the web page does too. Collab never sees a token. */
export const FILE_URL_PREFIX = '/public/v1/links/__TOKEN__/files/';
export const PUBLIC_HTML_LIMIT = 2_000_000;
const MAX_FILES = 200;
const NEUTRAL = 'An attachment is not available.';

function postJson(
  doFetch: typeof globalThis.fetch,
  url: string,
  secret: string,
  body: unknown,
): Promise<Response> {
  return doFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nix-internal-secret': secret },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
}

function readVerdicts(value: unknown): FileVerdict[] | null {
  if (!Array.isArray(value)) return null;
  const out: FileVerdict[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry) || typeof entry.id !== 'string') return null;
    const disposition = entry.disposition;
    if (disposition !== 'servable' && disposition !== 'withheld' && disposition !== 'hidden') {
      return null;
    }
    out.push({
      id: entry.id,
      disposition,
      name: typeof entry.name === 'string' ? entry.name : null,
      mediaType: typeof entry.mediaType === 'string' ? entry.mediaType : null,
    });
  }
  return out;
}

export function createPublicLinkCore(options: {
  coreBaseUrl: string;
  internalSecret: string;
  fetch?: typeof globalThis.fetch;
}): PublicLinkCore {
  const doFetch = options.fetch ?? globalThis.fetch;
  const call = async (
    scope: LinkScope,
    path: string,
    extra: Record<string, unknown>,
  ): Promise<unknown> => {
    try {
      const response = await postJson(
        doFetch,
        `${options.coreBaseUrl}/internal/public-links/${scope.linkId}/${path}`,
        options.internalSecret,
        {
          tenantId: scope.tenantId,
          principalId: scope.principalId,
          workspaceId: scope.workspaceId,
          itemId: scope.itemId,
          ...extra,
        },
      );
      if (response.status >= 500 || response.status === 429) return 'unavailable';
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return 'unavailable';
    }
  };
  return {
    async authorize(scope) {
      const answer = await call(scope, 'authorize', {});
      if (answer === 'unavailable') return 'unavailable';
      if (
        !isRecord(answer) ||
        answer.permission !== 'read' ||
        answer.itemId !== scope.itemId ||
        answer.workspaceId !== scope.workspaceId ||
        typeof answer.title !== 'string' ||
        typeof answer.bodyKind !== 'string'
      ) {
        return null;
      }
      return { title: answer.title, bodyKind: answer.bodyKind };
    },
    async files(scope, request) {
      const answer = await call(scope, 'files', request);
      if (answer === 'unavailable') return 'unavailable';
      if (!isRecord(answer)) return null;
      const blocks = readVerdicts(answer.blocks);
      const images = readVerdicts(answer.images);
      return blocks === null || images === null ? null : { blocks, images };
    },
  };
}

type Json = Record<string, unknown>;

function attrOf(node: Json, key: string): string | null {
  const value = rawAttr(node, key);
  return value !== null && key.toLowerCase().endsWith('id') && !isUuid(value) ? null : value;
}

function rawAttr(node: Json, key: string): string | null {
  const attrs = node.attrs;
  const value = isRecord(attrs) ? attrs[key] : undefined;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Block usage: attachments and item references. Image usage: inline image nodes. */
export function collectFiles(node: unknown, blocks: Set<string>, images: Set<string>): void {
  if (!isRecord(node)) return;
  if (
    node.type === 'itemBlock' &&
    (attrOf(node, 'presentation') ?? 'attachment') === 'attachment'
  ) {
    const id = attrOf(node, 'targetId');
    if (id !== null) blocks.add(id);
  } else if (node.type === 'reference' && (attrOf(node, 'kind') ?? 'item') === 'item') {
    const id = attrOf(node, 'targetId');
    if (id !== null) blocks.add(id);
  } else if (node.type === 'image') {
    const id = attrOf(node, 'fileItemId');
    if (id !== null) images.add(id);
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content as unknown[]) collectFiles(child, blocks, images);
  }
}

const paragraph = (text: string): Json => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

interface Verdicts {
  blocks: ReadonlyMap<string, FileVerdict>;
  images: ReadonlyMap<string, FileVerdict>;
}

/**
 * Removes every embedded item and swaps each attachment or image the reader may not download for
 * its name (a file the reader could see) or a neutral line (anything else). Returns null to drop.
 */
export function strip(node: unknown, verdicts: Verdicts): unknown {
  if (!isRecord(node)) return node;
  if (node.type === 'itemBlock') {
    if ((attrOf(node, 'presentation') ?? 'attachment') !== 'attachment') return null;
    const verdict = verdicts.blocks.get(attrOf(node, 'targetId') ?? '');
    if (verdict?.disposition === 'servable') return node;
    return paragraph(
      verdict?.disposition === 'withheld' && verdict.name !== null
        ? `${verdict.name} (not available)`
        : NEUTRAL,
    );
  }
  if (node.type === 'image') {
    const id = attrOf(node, 'fileItemId');
    if (id === null) return node; // an outside address renders as a link, never as a file
    const verdict = verdicts.images.get(id);
    if (verdict?.disposition === 'servable') return node;
    return paragraph(
      verdict?.disposition === 'withheld' && verdict.name !== null
        ? `${verdict.name} (not available)`
        : 'An image is not available.',
    );
  }
  if (!Array.isArray(node.content)) return node;
  const content: unknown[] = [];
  for (const child of node.content as unknown[]) {
    const kept = strip(child, verdicts);
    if (kept !== null) content.push(kept);
  }
  return { ...node, content };
}

export interface PublicNote {
  html: string;
  servableFileIds: string[];
  withheldFiles: { fileItemId: string; name: string }[];
}

/** Renders a note body for an anonymous reader. `verdictsFor` is Core's answer for the files named. */
export async function renderPublicNote(
  body: unknown,
  itemId: string,
  verdictsFor: (request: { blocks: string[]; images: string[] }) => Promise<Verdicts | null>,
): Promise<PublicNote | null> {
  // Pending suggestions are proposals: only the content as it stood shows, and files named only
  // inside a proposal are never asked about.
  const accepted = rejectAllSuggestions(body);
  const blocks = new Set<string>();
  const images = new Set<string>();
  collectFiles(accepted, blocks, images);
  if (blocks.size + images.size > MAX_FILES) return null;
  const verdicts =
    blocks.size + images.size === 0
      ? { blocks: new Map<string, FileVerdict>(), images: new Map<string, FileVerdict>() }
      : await verdictsFor({ blocks: [...blocks], images: [...images] });
  if (verdicts === null) return null;

  const link = (id: string) => `${FILE_URL_PREFIX}${id}`;
  const rendered = renderProse(strip(accepted, verdicts), itemId, createLossReport(), {
    pathOf: () => null,
    titleOf: () => null,
    diagram: () => null,
    asset: (id) =>
      verdicts.images.get(id)?.disposition === 'servable'
        ? { url: link(id), width: null, height: null }
        : null,
    download: (id) => {
      const verdict = verdicts.blocks.get(id);
      return verdict?.disposition === 'servable'
        ? {
            url: link(id),
            name: verdict.name ?? 'File',
            label: verdict.mediaType ?? 'File',
            isVideo: false,
          }
        : null;
    },
  });

  const servable = new Set<string>();
  const withheld = new Map<string, string>();
  const asked = [
    ...[...blocks].map((id) => verdicts.blocks.get(id)),
    ...[...images].map((id) => verdicts.images.get(id)),
  ];
  for (const verdict of asked) {
    if (verdict === undefined) continue;
    if (verdict.disposition === 'servable') servable.add(verdict.id);
    else if (verdict.disposition === 'withheld' && verdict.name !== null) {
      withheld.set(verdict.id, verdict.name);
    }
  }
  for (const id of servable) withheld.delete(id);
  return {
    html: rendered.html,
    servableFileIds: [...servable],
    withheldFiles: [...withheld].map(([fileItemId, name]) => ({ fileItemId, name })),
  };
}

export type NoteReader = (
  scope: TenantScope,
  itemId: string,
  workspaceId: string,
) => Promise<unknown>;

export function registerPublicLinkRoutes(
  app: FastifyInstance,
  deps: Pick<RouteDependencies, 'pool' | 'internalSecret' | 'publicLinkCore'> & {
    readNote?: NoteReader;
  },
): void {
  const readNote: NoteReader =
    deps.readNote ??
    ((scope, itemId, workspaceId) =>
      withTenantScope(deps.pool, scope, async (sql) => {
        const document = await findDocByItem(sql, scope.tenantId, itemId);
        if (document?.workspace_id !== workspaceId) return null;
        const state = await loadDocument(sql, scope.tenantId, document);
        try {
          return noteStrategy.materialize(state).json;
        } finally {
          state.destroy();
        }
      }));

  app.post<{ Params: { linkId: string }; Body: unknown }>(
    '/internal/public-links/:linkId/render',
    async (request, reply) => {
      if (!internalCaller(request, deps.internalSecret)) {
        return problem(reply, 404, 'document_not_found', 'No such item.');
      }
      const body = request.body;
      const ids = ['tenantId', 'principalId', 'workspaceId', 'itemId'] as const;
      if (
        !isUuid(request.params.linkId) ||
        !isRecord(body) ||
        ids.some((key) => typeof body[key] !== 'string' || !isUuid(body[key]))
      ) {
        return problem(reply, 400, 'invalid_request', 'A public link scope is required.');
      }
      const scope: LinkScope = {
        linkId: request.params.linkId,
        tenantId: body.tenantId as string,
        principalId: body.principalId as string,
        workspaceId: body.workspaceId as string,
        itemId: body.itemId as string,
      };
      const core = deps.publicLinkCore;
      const grant = await core?.authorize(scope);
      if (core === undefined || grant === undefined || grant === 'unavailable') {
        return problem(reply, 503, 'authorization_unavailable', 'Access could not be confirmed.');
      }
      if (grant === null || strategyFor(grant.bodyKind) !== noteStrategy) {
        return problem(reply, 404, 'document_not_found', 'No such item.');
      }

      const json = await readNote(scope, scope.itemId, scope.workspaceId);
      if (json === null || json === undefined) {
        return problem(reply, 404, 'document_not_found', 'No such item.');
      }
      const state = { unavailable: false };
      const note = await renderPublicNote(json, scope.itemId, async (files) => {
        const answer = await core.files(scope, files);
        if (answer === 'unavailable') state.unavailable = true;
        if (answer === null || answer === 'unavailable') return null;
        return {
          blocks: new Map(answer.blocks.map((entry) => [entry.id, entry])),
          images: new Map(answer.images.map((entry) => [entry.id, entry])),
        };
      });
      if (state.unavailable) {
        return problem(reply, 503, 'authorization_unavailable', 'Access could not be confirmed.');
      }
      if (note === null || note.html.length > PUBLIC_HTML_LIMIT) {
        return problem(reply, 413, 'note_not_publishable', 'This note cannot be shown publicly.');
      }
      void reply.header('cache-control', 'no-store');
      return { title: grant.title, ...note };
    },
  );
}
