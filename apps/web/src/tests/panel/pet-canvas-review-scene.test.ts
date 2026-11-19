import { expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  checkCanvasReviewRevision,
  loadCanvasReviewScene,
  parseCanvasReview,
} from '../../panel/pet-canvas-review-scene';

const itemId = '851e53ee-2eab-4c0c-95c3-e7571eed386b';
const docId = '66e6d2d7-de82-457d-bc6c-ba636f827096';
const anotherDocId = '29fa7458-00a8-46c9-acd5-b5d63090102d';
const collabUrl = 'https://nix.example/collab';
const token = 'test-browser-session-token';
const revision = { docId, headSeq: '9007199254740993' };
const start = {
  id: 'start',
  type: 'rectangle',
  version: 3,
  versionNonce: 24,
  x: -340,
  y: 30,
  width: 120,
  height: 60,
  index: 'a00',
  opacity: 100,
  link: 'https://example.test/external',
  customData: { url: 'https://example.test/custom' },
  boundElements: [{ id: 'caption', type: 'text' }],
};
const caption = { ...start, id: 'caption', type: 'text', containerId: start.id, index: 'a01' };
const removed = { ...start, id: 'removed', x: 1800, index: 'a03' };
const context = { ...start, id: 'context', x: 105, index: 'a02' };
const hidden = { ...start, id: 'hidden', x: 550, isDeleted: true };
const embed = { ...start, id: 'embed', type: 'embeddable', imageUrl: 'https://example.test/embed' };
const changes = [
  { before: start, after: { ...start, x: -500, version: 4 } },
  { before: null, after: { ...caption, id: 'new', y: 700, index: null } },
  { before: removed, after: { ...removed, version: 4, isDeleted: true } },
];

function preview(revisionValue: unknown = revision, changesValue: unknown = changes) {
  return { kind: 'canvas', itemId, preview: { revision: revisionValue, changes: changesValue } };
}

function draft() {
  const parsed = parseCanvasReview(preview());
  if (parsed === null) throw new Error('Expected a review draft');
  return parsed;
}

function snapshot(current = revision) {
  const doc = new Y.Doc();
  try {
    const map = doc.getMap('elements');
    for (const element of [start, caption, removed, context, hidden, embed]) {
      map.set(element.id, element);
    }
    return {
      ...current,
      checkpoint: {
        seq: current.headSeq,
        update: btoa(String.fromCharCode(...Y.encodeStateAsUpdate(doc))),
      },
      updates: [],
    };
  } finally {
    doc.destroy();
  }
}

function serveSnapshot(page = snapshot()) {
  return vi.fn((input: URL | RequestInfo, init?: RequestInit) => {
    const { signal, ...requestInit } = init ?? {};
    expect(signal).toBeInstanceOf(AbortSignal);
    const request = new Request(input, requestInit);
    expect(request.method).toBe('GET');
    expect(request.redirect).toBe('error');
    expect(request.headers.get('Authorization')).toBe(`Bearer ${token}`);
    expect(request.url).toBe(
      `${collabUrl}/documents/${itemId}/updates?after=0&fromCheckpoint=true`,
    );
    return Promise.resolve(Response.json(page));
  });
}

it('overlays the exact draft on the replayed canvas with surroundings, bindings, and removal bounds', async () => {
  const page = snapshot();
  const fetchImpl = serveSnapshot(page);
  const scene = await loadCanvasReviewScene({
    draft: draft(),
    collabUrl,
    token,
    fetchImpl,
    colors: { updated: 'steelblue', removed: 'maroon' },
  });

  expect(scene.kind).toBe('ready');
  if (scene.kind !== 'ready') return;
  expect(scene.counts).toEqual({ added: 1, updated: 1, removed: 1 });
  expect(scene.focusIds).toEqual(['start', 'new', 'removed']);
  expect(scene.elements.map(({ id }) => id)).toEqual([
    'new',
    'embed',
    'start',
    'caption',
    'context',
    'removed',
  ]);
  expect(scene.elements).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'start',
        x: -500,
        strokeColor: 'steelblue',
        strokeStyle: 'dotted',
        boundElements: [{ id: 'caption', type: 'text' }],
        link: null,
      }),
      expect.objectContaining({ id: 'new', y: 700, link: null }),
      expect.objectContaining({ id: 'caption', containerId: start.id, opacity: 45 }),
      expect.objectContaining({ id: 'embed', type: 'rectangle', link: null }),
      expect.objectContaining({
        id: 'removed',
        x: 1800,
        width: 120,
        version: 3,
        isDeleted: false,
        opacity: 100,
        strokeStyle: 'dashed',
        strokeColor: 'maroon',
      }),
    ]),
  );
  expect(scene.elements.find(({ id }) => id === 'new')).not.toHaveProperty('index');
  expect(scene.elements.every((element) => !('customData' in element))).toBe(true);
  expect(scene.elements.find(({ id }) => id === 'embed')).not.toHaveProperty('imageUrl');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(draft().changes[2]?.after.isDeleted).toBe(true);
});

it.each([
  { docId, headSeq: '9007199254740992' },
  { docId: anotherDocId, headSeq: revision.headSeq },
])('refuses a base with changed document ID or sequence ($docId/$headSeq)', async (current) => {
  const fetchImpl = serveSnapshot(snapshot(current));
  await expect(
    loadCanvasReviewScene({ draft: draft(), collabUrl, token, fetchImpl }),
  ).resolves.toEqual({
    kind: 'stale',
  });
});

it('requires complete revision and consistent element identities', () => {
  expect(parseCanvasReview(preview({ headSeq: '3' }))).toBeNull();
  expect(parseCanvasReview(preview(revision, [changes[0], changes[0]]))).toBeNull();
  expect(
    parseCanvasReview(preview(revision, [{ before: start, after: { ...start, id: 'other' } }])),
  ).toBeNull();
});

it('refuses a draft with pre-change geometry that differs from the exact base', async () => {
  const parsed = parseCanvasReview(
    preview(revision, [{ before: { ...start, x: -800 }, after: { ...start, version: 4 } }]),
  );
  if (parsed === null) throw new Error('Expected a review draft');
  const fetchImpl = serveSnapshot();
  await expect(
    loadCanvasReviewScene({ draft: parsed, collabUrl, token, fetchImpl }),
  ).rejects.toThrow('draft does not match');
});

it('checks the current Collab head without reading updates or sending a write', async () => {
  let current = revision;
  let canWrite = true;
  const fetchImpl = vi.fn((input: URL | RequestInfo, init?: RequestInit) => {
    const { signal, ...requestInit } = init ?? {};
    expect(signal).toBeInstanceOf(AbortSignal);
    const request = new Request(input, requestInit);
    expect(request.method).toBe('GET');
    expect(request.redirect).toBe('error');
    expect(request.headers.get('Authorization')).toBe(`Bearer ${token}`);
    expect(request.url).toBe(`${collabUrl}/documents/${itemId}/updates?after=9223372036854775807`);
    return Promise.resolve(Response.json({ ...current, canWrite, updates: [] }));
  });
  const source = { draft: draft(), collabUrl, token, fetchImpl };
  await expect(checkCanvasReviewRevision(source)).resolves.toBe('current');
  current = { ...current, headSeq: '9007199254740994' };
  await expect(checkCanvasReviewRevision(source)).resolves.toBe('stale');
  canWrite = false;
  await expect(checkCanvasReviewRevision(source)).rejects.toThrow('permission');
});

it('fails closed when the revision response is oversized', async () => {
  const fetchImpl = vi.fn(() =>
    Promise.resolve(
      Response.json({ ...revision, canWrite: true, updates: [], extra: 'a'.repeat(4096) }),
    ),
  );
  await expect(
    checkCanvasReviewRevision({ draft: draft(), collabUrl, token, fetchImpl }),
  ).rejects.toThrow('response is too large');
});
