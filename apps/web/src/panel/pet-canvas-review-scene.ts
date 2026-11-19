import {
  canvasChangeSchema,
  canvasElementSchema,
  sameCanvasElement,
  type CanvasElement,
} from '@nix/companion/canvas-plan';
import { bodyRevisionSchema, readGuardedBody, type BodySource } from '@nix/companion/guarded-body';
import {
  CANVAS_ELEMENTS,
  type CanvasElement as EditorElement,
} from '@nix/web-editor/editor/canvas-binding';
import { z } from 'zod';

const draftSchema = z
  .object({
    kind: z.literal('canvas'),
    itemId: z.uuid(),
    preview: z.object({
      revision: bodyRevisionSchema,
      changes: z.array(canvasChangeSchema).min(1).max(10_000),
    }),
  })
  .transform(({ itemId, preview }) => ({ itemId, ...preview }))
  .refine(({ changes }) => {
    const ids = new Set<string>();
    for (const { before, after } of changes) {
      if (
        ids.has(after.id) ||
        (before !== null && before.id !== after.id) ||
        (after.isDeleted && (before === null || before.isDeleted))
      ) {
        return false;
      }
      ids.add(after.id);
    }
    return true;
  });

export type CanvasReviewDraft = z.output<typeof draftSchema>;

type ChangeKind = 'added' | 'updated' | 'removed';
type ReviewSource = Omit<BodySource, 'itemId'> & { readonly draft: CanvasReviewDraft };

export type CanvasReviewScene =
  | { readonly kind: 'stale' }
  | {
      readonly kind: 'ready';
      readonly elements: readonly EditorElement[];
      readonly focusIds: readonly string[];
      readonly counts: Readonly<Record<ChangeKind, number>>;
    };

export function parseCanvasReview(preview: unknown): CanvasReviewDraft | null {
  return draftSchema.safeParse(preview).data ?? null;
}

function sameRevision(
  current: CanvasReviewDraft['revision'],
  expected: CanvasReviewDraft['revision'],
): boolean {
  return current.docId === expected.docId && current.headSeq === expected.headSeq;
}

function reviewElement(
  element: CanvasElement,
  change: ChangeKind | undefined,
  colors: Partial<Record<ChangeKind, string>>,
): EditorElement {
  const { index, ...geometry } = element;
  delete geometry.customData;
  delete geometry.itemId;
  delete geometry.imageItemId;
  delete geometry.imageUrl;
  delete geometry.fileId;
  const type = ['iframe', 'embeddable', 'image'].includes(element.type)
    ? 'rectangle'
    : element.type;
  const opacity = typeof element.opacity === 'number' ? element.opacity : 100;
  const strokeColor = change === undefined ? undefined : colors[change];

  return {
    ...geometry,
    type,
    link: null,
    isDeleted: false,
    ...(typeof index === 'string' ? { index } : {}),
    ...(change === undefined ? { opacity: Math.round(opacity * 0.45) } : {}),
    ...(change === 'updated' ? { strokeStyle: 'dotted' } : {}),
    ...(change === 'removed' ? { strokeStyle: 'dashed', opacity: 100 } : {}),
    ...(strokeColor === undefined ? {} : { strokeColor }),
  };
}

function byDrawOrder(a: EditorElement, b: EditorElement): number {
  const left = a.index ?? '';
  const right = b.index ?? '';
  const [first, second] = left === right ? [a.id, b.id] : [left, right];
  return first === second ? 0 : first < second ? -1 : 1;
}

export async function loadCanvasReviewScene(
  {
    draft,
    colors = {},
    ...source
  }: ReviewSource & {
    readonly colors?: Partial<Record<ChangeKind, string>>;
  },
  signal?: AbortSignal,
): Promise<CanvasReviewScene> {
  const { doc, revision } = await readGuardedBody({ ...source, itemId: draft.itemId }, signal);
  try {
    if (!sameRevision(revision, draft.revision)) return { kind: 'stale' };

    const map = doc.getMap(CANVAS_ELEMENTS);
    if (map.size > 10_000) throw new Error('The canvas has too many elements to preview.');
    const base = new Map<string, CanvasElement>();
    const scene = new Map<string, EditorElement>();
    for (const [id, value] of map) {
      const element = canvasElementSchema.parse(value);
      if (element.id !== id)
        throw new Error('The canvas contains inconsistent element identities.');
      base.set(id, element);
      if (!element.isDeleted) scene.set(id, reviewElement(element, undefined, colors));
    }

    const focusIds: string[] = [];
    const counts = { added: 0, updated: 0, removed: 0 };
    for (const { before, after } of draft.changes) {
      if (!sameCanvasElement(before, base.get(after.id) ?? null)) {
        throw new Error('The draft does not match the approved canvas revision.');
      }
      const change: { kind: ChangeKind; element: CanvasElement } =
        after.isDeleted && before !== null
          ? { kind: 'removed', element: before }
          : {
              kind: before === null || before.isDeleted ? 'added' : 'updated',
              element: after,
            };
      counts[change.kind]++;
      focusIds.push(after.id);
      scene.set(after.id, reviewElement(change.element, change.kind, colors));
    }
    return { kind: 'ready', elements: [...scene.values()].sort(byDrawOrder), focusIds, counts };
  } finally {
    doc.destroy();
  }
}

const revisionResponse = bodyRevisionSchema.loose().extend({
  canWrite: z.boolean(),
  updates: z.array(z.never()).length(0),
});

export async function checkCanvasReviewRevision(
  { draft, collabUrl, token, fetchImpl = fetch }: ReviewSource,
  signal?: AbortSignal,
): Promise<'current' | 'stale'> {
  const origin = new URL(collabUrl);
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  ) {
    throw new Error('Invalid collaboration origin.');
  }
  const itemId = z.uuid().parse(draft.itemId);
  const url = new URL(`documents/${itemId}/updates`, origin.href.replace(/\/?$/u, '/'));
  // Collab reports the current head even when no updates follow the maximum Postgres bigint.
  url.searchParams.set('after', '9223372036854775807');
  const timeout = AbortSignal.timeout(10_000);
  const response = await fetchImpl(url, {
    cache: 'no-store',
    redirect: 'error',
    headers: { authorization: `Bearer ${token}` },
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  });
  if (!response.ok || response.body === null) {
    throw new Error('The canvas revision could not be checked.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let json = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4_096) throw new Error('The canvas revision response is too large.');
      json += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const current = revisionResponse.parse(JSON.parse(json + decoder.decode()));
  if (!current.canWrite) throw new Error('You no longer have permission to edit this canvas.');
  return sameRevision(current, draft.revision) ? 'current' : 'stale';
}
