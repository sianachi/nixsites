import {
  canvasChangeSchema,
  canvasElementSchema,
  compileCanvasPlan,
  invertCanvasChanges,
  type CanvasChange,
  type CanvasElement,
} from '@nix/companion/canvas-plan';
import {
  appendGuardedBody,
  bodyRevisionSchema,
  encodeGuardedBodyChange,
  GuardedBodyError,
  readGuardedBody,
  type BodySource,
} from '@nix/companion/guarded-body';
import { z } from 'zod';
import {
  createServerPlanFetch,
  planExecutionEnvelopeSchema,
  type PlanDispatchOptions,
} from './plan-dispatch.ts';

const receiptSchema = z.strictObject({
  docId: z.uuid(),
  seq: z.string(),
  changes: z.array(canvasChangeSchema).min(1).max(1024),
});
const previewSchema = z.strictObject({
  revision: bodyRevisionSchema,
  changes: z.array(canvasChangeSchema).min(1).max(1024),
  scene: z.array(canvasElementSchema).max(1024),
  links: z.array(z.uuid()).max(128),
  update: z
    .string()
    .min(1)
    .max(1024 * 1024),
});
export type CanvasPreview = z.infer<typeof previewSchema>;
export type CanvasReceipt = z.infer<typeof receiptSchema>;

function boundReceipt(changes: readonly CanvasChange[]): void {
  // Core has a finite receipt budget. Reject during preparation, before a write could succeed.
  if (Buffer.byteLength(JSON.stringify(changes)) > 56_000)
    throw new Error(
      'This canvas edit is too large to record and undo. Split it into smaller actions.',
    );
}

const accessShape = {
  itemId: z.uuid(),
  token: z.string().min(1).max(4096),
  planExecution: planExecutionEnvelopeSchema.optional(),
};
const readQuery = z.strictObject({
  after: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,96}$/u)
    .optional(),
  limit: z.number().int().min(1).max(4).default(2),
});
const metadata = z.looseObject({ nix: z.looseObject({ kind: z.string(), itemId: z.string() }) });
const endBinding = z.looseObject({ elementId: z.string() });
const nixLinkPrefix = 'nix://item/';
const requestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...accessShape, operation: z.literal('read'), query: readQuery }),
  z.strictObject({ ...accessShape, operation: z.literal('preview'), plan: z.unknown() }),
  z.strictObject({
    ...accessShape,
    operation: z.literal('apply'),
    actionId: z.uuid(),
    preview: previewSchema,
  }),
  z.strictObject({
    ...accessShape,
    operation: z.literal('undo'),
    actionId: z.uuid(),
    receipt: receiptSchema,
  }),
]);

function sceneFrom(map: { toJSON(): Record<string, unknown> }): CanvasElement[] {
  const entries = Object.entries(map.toJSON());
  if (entries.length > 10_000) throw new Error('The canvas has too many elements.');
  return entries.map(([key, value]) => {
    const element = canvasElementSchema.parse(value);
    if (element.id !== key) throw new Error('The canvas contains inconsistent element identities.');
    return element;
  });
}

function linkedItems(element: CanvasElement): string[] {
  const info = metadata.safeParse(element.customData).data?.nix;
  const ids = info?.kind === 'item' || info?.kind === 'file' ? [info.itemId] : [];
  if (element.type === 'card' && typeof element.itemId === 'string') ids.push(element.itemId);
  if (element.type === 'image' && typeof element.imageItemId === 'string')
    ids.push(element.imageItemId);
  if (typeof element.link === 'string' && element.link.startsWith(nixLinkPrefix)) {
    const target = element.link.slice(nixLinkPrefix.length);
    try {
      ids.push(decodeURIComponent(target));
    } catch {
      ids.push(target);
    }
  }
  return ids;
}

function referencedLinks(
  element: CanvasElement,
  byId: ReadonlyMap<string, CanvasElement>,
): string[] {
  const ids = [
    typeof element.containerId === 'string' ? element.containerId : undefined,
    endBinding.safeParse(element.startBinding).data?.elementId,
    endBinding.safeParse(element.endBinding).data?.elementId,
  ];
  return [
    ...linkedItems(element),
    ...ids.flatMap((id) => {
      const referenced = id === undefined ? undefined : byId.get(id);
      return referenced === undefined ? [] : linkedItems(referenced);
    }),
  ];
}

interface ElementSummary {
  id: string;
  type: string;
  x: number | undefined;
  y: number | undefined;
  width: number | undefined;
  height: number | undefined;
  text?: string;
}

interface CanvasReadResult {
  total: number;
  elements: ElementSummary[];
  next?: string;
}

function summary(element: CanvasElement): ElementSummary {
  const coordinate = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined;
  return {
    id: element.id,
    type: element.type.slice(0, 40),
    x: coordinate(element.x),
    y: coordinate(element.y),
    width: coordinate(element.width),
    height: coordinate(element.height),
    ...(element.type === 'text' && typeof element.text === 'string'
      ? { text: element.text.slice(0, 72) }
      : {}),
  };
}

export async function readPetCanvas(
  source: BodySource,
  query: z.infer<typeof readQuery>,
): Promise<CanvasReadResult> {
  const snapshot = await readGuardedBody(source);
  try {
    const elements = sceneFrom(snapshot.doc.getMap('elements'));
    const byId = new Map(elements.map((element) => [element.id, element]));
    const scene = elements
      .filter(
        (element) =>
          !element.isDeleted &&
          /^[a-zA-Z0-9_-]{1,96}$/u.test(element.id) &&
          referencedLinks(element, byId).length === 0,
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    const after =
      query.after === undefined ? -1 : scene.findIndex((element) => element.id === query.after);
    if (after === -1 && query.after !== undefined)
      throw new Error('The canvas changed during paging. Read it again from the beginning.');
    const values: ElementSummary[] = [];
    for (const element of scene.slice(after + 1, after + 1 + query.limit)) {
      const elementSummary = summary(element);
      if (Buffer.byteLength(JSON.stringify([...values, elementSummary])) > 450) {
        if (values.length !== 0) break;
        delete elementSummary.text;
      }
      values.push(elementSummary);
    }
    const last = values.at(-1)?.id;
    return {
      total: scene.length,
      elements: values,
      ...(last !== undefined && after + 1 + values.length < scene.length ? { next: last } : {}),
    };
  } finally {
    snapshot.doc.destroy();
  }
}

function stage(
  source: Awaited<ReturnType<typeof readGuardedBody>>,
  changes: readonly CanvasChange[],
) {
  const elements = source.doc.getMap<CanvasElement>('elements');
  return encodeGuardedBodyChange(source.doc, () => {
    for (const { after } of changes) elements.set(after.id, after);
  });
}

export async function previewPetCanvas(
  source: BodySource & { plan: unknown },
): Promise<CanvasPreview> {
  const snapshot = await readGuardedBody(source);
  try {
    const scene = sceneFrom(snapshot.doc.getMap('elements'));
    const changes = compileCanvasPlan(scene, source.plan, Date.now());
    boundReceipt(changes);
    const update = stage(snapshot, changes);
    const previousById = new Map(scene.map((element) => [element.id, element]));
    const nextById = new Map(previousById);
    for (const { after } of changes) nextById.set(after.id, after);
    const preview = previewSchema.parse({
      revision: snapshot.revision,
      changes,
      scene: changes.flatMap(({ after }) => (after.isDeleted ? [] : [after])),
      links: [
        ...new Set(
          changes.flatMap(({ before, after }) => [
            ...(before === null ? [] : referencedLinks(before, previousById)),
            ...referencedLinks(after, nextById),
          ]),
        ),
      ],
      update,
    });
    if (Buffer.byteLength(JSON.stringify(preview)) > 512 * 1024)
      throw new Error(
        'This canvas edit is too large to show for review. Split it into smaller actions.',
      );
    return preview;
  } finally {
    snapshot.doc.destroy();
  }
}

/** Only the exact reviewed bytes are submitted to Collab. */
export async function applyPetCanvas(
  source: BodySource & { preview: CanvasPreview; actionId: string },
): Promise<CanvasReceipt> {
  const preview = previewSchema.parse(source.preview);
  boundReceipt(preview.changes);
  const result = await appendGuardedBody(
    source,
    preview.revision,
    preview.update,
    `canvas-apply:${source.actionId}`,
  );
  return { ...result, changes: preview.changes };
}

export async function undoPetCanvas(
  source: BodySource & { receipt: CanvasReceipt; actionId: string },
): Promise<CanvasReceipt> {
  const receipt = receiptSchema.parse(source.receipt);
  const snapshot = await readGuardedBody(source);
  try {
    if (snapshot.revision.docId !== receipt.docId)
      throw new Error('The canvas body was replaced after this action.');
    const current = sceneFrom(snapshot.doc.getMap('elements'));
    const changes = invertCanvasChanges(current, receipt.changes, Date.now());
    boundReceipt(changes);
    const update = stage(snapshot, changes);
    const result = await appendGuardedBody(
      source,
      snapshot.revision,
      update,
      `canvas-undo:${source.actionId}`,
    );
    return { ...result, changes };
  } finally {
    snapshot.doc.destroy();
  }
}

/** Only called on the internal shared-secret route. No model parameter is passed through as Yjs. */
export async function runPetCanvas(
  input: unknown,
  collabUrl: string,
  dispatchOptions?: PlanDispatchOptions,
  fetchImpl?: typeof fetch,
): Promise<
  | { ok: true; result: CanvasPreview | CanvasReceipt | CanvasReadResult }
  | { ok: false; uncertain: boolean; stale?: true; error: string }
> {
  const request = requestSchema.safeParse(input);
  if (!request.success) return { ok: false, uncertain: false, error: 'Invalid canvas action.' };
  if (request.data.planExecution !== undefined && dispatchOptions === undefined)
    return { ok: false, uncertain: false, error: 'The native plan dispatcher is unavailable.' };
  const send =
    request.data.planExecution !== undefined && dispatchOptions !== undefined
      ? createServerPlanFetch(dispatchOptions, request.data.planExecution, fetchImpl)
      : fetchImpl;
  const source = {
    collabUrl,
    itemId: request.data.itemId,
    token: request.data.token,
    ...(send === undefined ? {} : { fetchImpl: send }),
  };
  try {
    switch (request.data.operation) {
      case 'read':
        return { ok: true, result: await readPetCanvas(source, request.data.query) };
      case 'preview':
        return { ok: true, result: await previewPetCanvas({ ...source, plan: request.data.plan }) };
      case 'apply':
        return { ok: true, result: await applyPetCanvas({ ...source, ...request.data }) };
      case 'undo':
        return { ok: true, result: await undoPetCanvas({ ...source, ...request.data }) };
    }
  } catch (error) {
    return {
      ok: false,
      uncertain: error instanceof GuardedBodyError && error.uncertain,
      ...(error instanceof GuardedBodyError && error.stale && !error.uncertain
        ? { stale: true as const }
        : {}),
      error:
        error instanceof z.ZodError
          ? 'Invalid canvas geometry or arguments.'
          : error instanceof Error
            ? error.message.slice(0, 500)
            : 'The canvas action failed.',
    };
  }
}
