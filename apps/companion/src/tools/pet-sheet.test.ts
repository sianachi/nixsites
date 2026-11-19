import { readGuardedBody } from '@nix/companion/guarded-body';
import { readCells } from '@nix/sheet';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { runPetSheet } from './pet-sheet.ts';

const itemId = '20000000-0000-4000-8000-000000000001';
const docId = '20000000-0000-4000-8000-000000000002';
const actionId = '20000000-0000-4000-8000-000000000003';
const target = { itemId, token: 'sheet-fixture' };
const collabUrl = 'https://collab.invalid';
const posted = z.object({
  clientId: z.string(),
  update: z.string(),
  expectedDocId: z.uuid(),
  expectedHeadSeq: z.string(),
});

it('persists a reviewed native sheet delta once, rejects a stale preview, and undoes with a second guarded delta', async () => {
  const updates: { seq: string; update: string }[] = [];
  const retained = new Map<string, { body: string; seq: string }>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    expect(request.headers.get('authorization')).toBe('Bearer sheet-fixture');
    expect(new URL(request.url).pathname).toBe(`/documents/${itemId}/updates`);
    if (request.method === 'GET') {
      return Response.json({ docId, headSeq: String(updates.length), updates });
    }
    const body = await request.text();
    const payload = posted.parse(JSON.parse(body));
    const old = retained.get(payload.clientId);
    if (old?.body === body) return Response.json({ docId, seq: old.seq });
    if (payload.expectedDocId !== docId || payload.expectedHeadSeq !== String(updates.length)) {
      return new Response(null, { status: 409 });
    }
    const seq = String(updates.length + 1);
    updates.push({ seq, update: payload.update });
    retained.set(payload.clientId, { body, seq });
    return Response.json({ docId, seq });
  };
  const planned = await runPetSheet(
    { ...target, kind: 'preview', plan: { cells: [{ cell: 'A1', value: '=2+3' }] } },
    collabUrl,
    fetchImpl,
  );
  if (!planned?.ok || !('preview' in planned)) throw new Error('A preview was expected.');
  const { preview } = planned;
  expect(preview.changes).toEqual([{ kind: 'cell', cell: 'A1', before: null, after: '=2+3' }]);
  expect(updates).toHaveLength(0);

  const apply = { ...target, kind: 'apply', preview, actionId };
  const applied = await runPetSheet(apply, collabUrl, fetchImpl);
  if (!applied?.ok || !('receipt' in applied)) throw new Error('A receipt was expected.');
  expect(await runPetSheet(apply, collabUrl, fetchImpl)).toEqual(applied);
  expect(updates).toHaveLength(1);
  const { doc: edited } = await readGuardedBody({ ...target, collabUrl, fetchImpl });
  expect(readCells(edited).get('A1')).toBe('=2+3');
  edited.destroy();

  expect(await runPetSheet({ ...apply, actionId: itemId }, collabUrl, fetchImpl)).toMatchObject({
    ok: false,
    code: 'sheet_edit.refused',
  });
  const undone = await runPetSheet(
    { ...target, kind: 'undo', preview, receipt: applied.receipt, actionId },
    collabUrl,
    fetchImpl,
  );
  expect(undone).toEqual({ ok: true, receipt: { docId, seq: '2', changes: 1 } });
  const { doc } = await readGuardedBody({ ...target, collabUrl, fetchImpl });
  expect(readCells(doc).size).toBe(0);
  doc.destroy();
});
