import { readGuardedBody } from '@nix/companion/guarded-body';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { applyPetCanvas, previewPetCanvas, readPetCanvas, undoPetCanvas } from './pet-canvas.ts';

const itemId = '851e53ee-2eab-4c0c-95c3-e7571eed386b';
const docId = '66e6d2d7-de82-457d-bc6c-ba636f827096';
const linkedItemId = '590e27a0-a894-475c-b76a-1dd5fef759c4';
const placement = { x: 0, y: 0, width: 160, height: 80 };
const transport = z.object({
  expectedDocId: z.uuid(),
  expectedHeadSeq: z.string(),
  clientId: z.string(),
  update: z.string(),
});

it('previews without writing, applies one exact update, and undoes it beside an independent edit', async () => {
  const updates: { seq: string; update: string }[] = [];
  const sent: z.infer<typeof transport>[] = [];
  const source = {
    collabUrl: 'http://collab.test',
    itemId,
    token: 'scoped-test-credential',
    fetchImpl: async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ): Promise<Response> => {
      const request = new Request(input, init);
      if (request.method === 'GET') {
        const after = Number(new URL(request.url).searchParams.get('after'));
        return Response.json({
          docId,
          headSeq: String(updates.length),
          updates: updates.slice(after),
        });
      }
      const body = transport.parse(await request.json());
      expect(request.headers.get('authorization')).toBe('Bearer scoped-test-credential');
      expect(body.expectedDocId).toBe(docId);
      sent.push(body);
      if (body.expectedHeadSeq !== String(updates.length))
        return new Response(null, { status: 409 });
      const seq = String(updates.length + 1);
      updates.push({ seq, update: body.update });
      return Response.json({ docId, seq }, { status: 202 });
    },
  };
  const preview = await previewPetCanvas({
    ...source,
    plan: {
      elements: [
        { id: 'start', type: 'rectangle', ...placement, nixItemId: linkedItemId },
        { id: 'linked-label', type: 'text', containerId: 'start', text: 'Linked title only' },
        { id: 'end', type: 'ellipse', ...placement, x: 300 },
        { id: 'edge', type: 'arrow', from: 'start', to: 'end' },
      ],
    },
  });
  expect(preview.scene.length).toBe(4);
  expect(preview.links).toEqual([linkedItemId]);
  expect(sent).toHaveLength(0);

  const receipt = await applyPetCanvas({
    ...source,
    preview,
    actionId: '7e7bd27c-e712-44ab-abba-971e183bf3b0',
  });
  expect(sent[0]).toMatchObject({ update: preview.update, expectedHeadSeq: '0' });
  expect(receipt.seq).toBe('1');
  expect(await readPetCanvas(source, { limit: 1 })).toEqual({
    total: 1,
    elements: [{ id: 'end', type: 'ellipse', ...placement, x: 300 }],
  });
  const labelChange = await previewPetCanvas({
    ...source,
    plan: {
      elements: [{ id: 'linked-label', type: 'text', containerId: 'start', text: 'New title' }],
    },
  });
  expect(labelChange.links).toEqual([linkedItemId]);
  const other = await previewPetCanvas({
    ...source,
    plan: { elements: [{ id: 'independent', type: 'text', x: 22, y: 100, text: 'Separate edit' }] },
  });
  await applyPetCanvas({
    ...source,
    preview: other,
    actionId: 'a47729f0-06a0-498b-be17-4a82bf152789',
  });
  await expect(
    applyPetCanvas({
      ...source,
      preview: labelChange,
      actionId: 'abcddd88-0097-4300-ba69-2c8cba12fe98',
    }),
  ).rejects.toMatchObject({ stale: true, uncertain: false });
  expect(updates).toHaveLength(2);
  expect(await readPetCanvas(source, { limit: 1 })).toMatchObject({ total: 2, next: 'end' });
  expect(await readPetCanvas(source, { limit: 1, after: 'end' })).toMatchObject({
    elements: [{ id: 'independent', text: 'Separate edit' }],
  });

  // The preview crossed a JSONB checkpoint, which doesn't preserve native key insertion order.
  const stored = {
    ...receipt,
    changes: receipt.changes.map(({ before, after }) => ({
      before,
      after: {
        ...Object.fromEntries(Object.entries(after).reverse()),
        id: after.id,
        type: after.type,
        version: after.version,
        versionNonce: after.versionNonce,
      },
    })),
  };
  await undoPetCanvas({
    ...source,
    receipt: stored,
    actionId: '7e7bd27c-e712-44ab-abba-971e183bf3b0',
  });
  const { doc, revision } = await readGuardedBody(source);
  try {
    expect(revision.headSeq).toBe('3');
    expect(doc.getMap('elements').get('start')).toMatchObject({ isDeleted: true, version: 2 });
    expect(doc.getMap('elements').get('edge')).toMatchObject({ isDeleted: true, version: 2 });
    expect(doc.getMap('elements').get('independent')).toMatchObject({
      isDeleted: false,
      text: 'Separate edit',
      version: 1,
    });
    expect(sent).toHaveLength(4);
    expect(sent.at(-1)?.clientId).toBe('nix-pet-canvas-undo-7e7bd27c-e712-44ab-abba-971e183bf3b0');
  } finally {
    doc.destroy();
  }
});

it('reports an unverifiable receipt as uncertain after sending the reviewed update once', async () => {
  const source = { collabUrl: 'http://collab.test', itemId, token: 'scoped-test-credential' };
  const preview = await previewPetCanvas({
    ...source,
    plan: { elements: [{ id: 'box', type: 'rectangle', ...placement }] },
    fetchImpl: (): Promise<Response> =>
      Promise.resolve(Response.json({ docId, headSeq: '0', updates: [] })),
  });
  let sends = 0;
  await expect(
    applyPetCanvas({
      ...source,
      preview,
      actionId: '7e7bd27c-e712-44ab-abba-971e183bf3b0',
      fetchImpl: (): Promise<Response> => {
        sends++;
        return Promise.resolve(Response.json({ docId, seq: '2' }, { status: 202 }));
      },
    }),
  ).rejects.toMatchObject({ uncertain: true });
  expect(sends).toBe(1);
});
