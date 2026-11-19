import {
  GuardedBodyError,
  appendGuardedBody,
  bodyRevisionSchema,
  encodeGuardedBodyChange,
  readGuardedBody,
} from '@nix/companion/guarded-body';
import {
  MAX_SHEET_EDITS,
  SHEET_COLUMN_WIDTH,
  SHEET_LIMITS,
  SheetEditError,
  applySheetEdit,
  invertSheetEdit,
  previewSheetEdit,
} from '@nix/sheet';
import { z } from 'zod';

const MAX_PREVIEW_BYTES = 48 * 1024;
const cell = z.string().regex(/^[A-Z]{1,2}[1-9][0-9]{0,4}$/u);
const column = z.string().regex(/^[A-Z]{1,2}$/u);
const cellValue = z.string().min(1).max(SHEET_LIMITS.maxRawLength).nullable();
const extent = z.number().int().min(1).max(SHEET_LIMITS.maxRows);
const width = z.number().int().min(SHEET_COLUMN_WIDTH.min).max(SHEET_COLUMN_WIDTH.max).nullable();
const plan = z.strictObject({
  cells: z
    .array(z.strictObject({ cell, value: cellValue }))
    .max(MAX_SHEET_EDITS)
    .default([]),
  rows: extent.optional(),
  columns: z.number().int().min(1).max(SHEET_LIMITS.maxCols).optional(),
  columnWidths: z.array(z.strictObject({ column, width })).max(MAX_SHEET_EDITS).default([]),
});
const change = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('cell'), cell, before: cellValue, after: cellValue }),
  z.strictObject({
    kind: z.literal('extent'),
    axis: z.enum(['rows', 'cols']),
    before: extent.nullable(),
    after: extent.nullable(),
  }),
  z.strictObject({ kind: z.literal('width'), column, before: width, after: width }),
]);
const preview = z.strictObject({
  revision: bodyRevisionSchema,
  changes: z.array(change).min(1).max(MAX_SHEET_EDITS),
  update: z.string().min(1).max(MAX_PREVIEW_BYTES),
});
const receipt = z.strictObject({
  docId: z.uuid(),
  seq: z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/u),
  changes: z.number().int().min(1).max(MAX_SHEET_EDITS),
});
const target = { itemId: z.uuid(), token: z.string().min(1).max(8192) };
const request = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('preview'), ...target, plan }),
  z.strictObject({ kind: z.literal('apply'), ...target, preview, actionId: z.uuid() }),
  z.strictObject({ kind: z.literal('undo'), ...target, preview, receipt, actionId: z.uuid() }),
]);

type PetSheetResponse =
  | { ok: true; preview: z.infer<typeof preview> }
  | { ok: true; receipt: z.infer<typeof receipt> }
  | { ok: false; code: 'sheet_edit.uncertain' | 'sheet_edit.refused'; detail: string };

/** The trusted Core-to-companion contract for one reviewed native sheet change. */
export async function runPetSheet(
  input: unknown,
  collabUrl: string,
  fetchImpl?: typeof fetch,
): Promise<PetSheetResponse | undefined> {
  const parsed = request.safeParse(input);
  if (!parsed.success || collabUrl === '') return undefined;
  const action = parsed.data;
  const source = {
    collabUrl,
    itemId: action.itemId,
    token: action.token,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  };
  try {
    if (action.kind === 'apply') {
      // Persist the reviewed bytes to make an exact retry return the same Collab receipt.
      const applied = await appendGuardedBody(
        source,
        action.preview.revision,
        action.preview.update,
        `sheet-apply:${action.actionId}`,
      );
      return { ok: true, receipt: { ...applied, changes: action.preview.changes.length } } as const;
    }

    const { doc, revision } = await readGuardedBody(source);
    try {
      if (action.kind === 'preview') {
        const changes = previewSheetEdit(doc, action.plan);
        if (changes.length === 0) throw new SheetEditError('The sheet already has those values.');
        const update = encodeGuardedBodyChange(doc, () => {
          applySheetEdit(doc, changes);
        });
        const reviewed = { revision, changes, update };
        if (Buffer.byteLength(JSON.stringify(reviewed)) > MAX_PREVIEW_BYTES) {
          throw new SheetEditError('Split the sheet edit into smaller batches.');
        }
        return { ok: true, preview: reviewed } as const;
      }
      if (
        action.receipt.docId !== revision.docId ||
        action.receipt.docId !== action.preview.revision.docId ||
        action.receipt.changes !== action.preview.changes.length ||
        BigInt(action.receipt.seq) <= BigInt(action.preview.revision.headSeq) ||
        BigInt(action.receipt.seq) > BigInt(revision.headSeq)
      ) {
        throw new SheetEditError('The sheet changed. Review the current sheet first.');
      }
      const undo = encodeGuardedBodyChange(doc, () => {
        applySheetEdit(doc, invertSheetEdit(action.preview.changes));
      });
      const applied = await appendGuardedBody(
        source,
        revision,
        undo,
        `sheet-undo:${action.actionId}`,
      );
      return { ok: true, receipt: { ...applied, changes: action.receipt.changes } } as const;
    } finally {
      doc.destroy();
    }
  } catch (error) {
    const uncertain = error instanceof GuardedBodyError && error.uncertain;
    return {
      ok: false,
      code: uncertain ? 'sheet_edit.uncertain' : 'sheet_edit.refused',
      detail:
        error instanceof SheetEditError
          ? error.message
          : uncertain
            ? 'The sheet write could not be verified. Review its current state before retrying.'
            : 'Collaboration refused the sheet action. Reopen the task and prepare a fresh review.',
    } as const;
  }
}
