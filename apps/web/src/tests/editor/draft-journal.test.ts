import 'fake-indexeddb/auto';
import * as Y from 'yjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDraftJournal,
  type DraftJournalStore,
  type DraftRecord,
  type DraftState,
  clearDrafts,
  acknowledgeDrafts,
  readDrafts,
  writeDraft,
  listDraftScopes,
} from '../../editor/draft-journal';
import {
  clearBodyCache,
  documentScope,
  openBodyCache,
  sealItemBodies,
} from '../../editor/body-cache';

function storage(): DraftJournalStore {
  const records = new Map<string, DraftRecord>();
  return {
    read: (scope) =>
      Promise.resolve([...records.values()].filter((record) => record.scope === scope)),
    write: (record) => {
      records.set(record.id, record);
      return Promise.resolve();
    },
    acknowledge: (acknowledged) => {
      for (const record of acknowledged)
        if (records.get(record.id)?.revision === record.revision) records.delete(record.id);
      return Promise.resolve();
    },
  };
}
function update(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('note').insert(0, text);
  const bytes = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytes;
}
describe('pending note drafts', () => {
  it('recovers a locally saved edit in a new editor without crossing account scopes', async () => {
    const store = storage();
    const states: DraftState[] = [];
    const first = createDraftJournal('alice:workspace:note', (state) => states.push(state), store);
    first.append(update('Recover me'));
    await first.snapshot();
    expect(states).toEqual(['saving', 'local']);
    const reopened = createDraftJournal('alice:workspace:note', () => undefined, store);
    const records = await reopened.read();
    const doc = new Y.Doc();
    for (const record of records) Y.applyUpdate(doc, record.update);
    expect(doc.getText('note').toJSON()).toBe('Recover me');
    expect(await createDraftJournal('bob:workspace:note', () => undefined, store).read()).toEqual(
      [],
    );
    doc.destroy();
  });
  it('does not acknowledge another active tab’s unsent edits', async () => {
    const store = storage();
    const first = createDraftJournal('same-note', () => undefined, store);
    const second = createDraftJournal('same-note', () => undefined, store);
    await first.read();
    await second.read();
    first.append(update('First'));
    second.append(update('Second'));
    const secondRecords = await second.snapshot();
    await first.acknowledge(await first.snapshot());
    expect(await store.read('same-note')).toEqual(secondRecords);
  });
  it('retains edits made while the server acknowledges an earlier revision', async () => {
    const store = storage();
    const journal = createDraftJournal('note', () => undefined, store);
    journal.append(update('First'));
    const earlier = await journal.snapshot();
    journal.append(update('Later'));
    const later = await journal.snapshot();
    await journal.acknowledge(earlier);
    expect(await store.read('note')).toEqual(later);
  });
  it('reports storage refusal without claiming a local save', async () => {
    const states: DraftState[] = [];
    const store = storage();
    store.write = () => Promise.reject(new Error('Quota exceeded'));
    const journal = createDraftJournal('note', (state) => states.push(state), store);
    journal.append(update('Keep in the open tab'));
    await expect(journal.snapshot()).rejects.toThrow('Quota exceeded');
    expect(states).toEqual(['saving', 'error']);
  });
  it('discards and disables the journal when editing permission is revoked', async () => {
    const store = storage();
    const journal = createDraftJournal('note', () => undefined, store);
    journal.append(update('Before revocation'));
    await journal.discard();
    journal.append(update('After revocation'));
    expect(await journal.snapshot()).toEqual([]);
  });
});

describe('account-scoped draft persistence', () => {
  beforeEach(async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    await clearBodyCache();
    await clearDrafts();
    await openBodyCache('alice');
  });

  const scope = (itemId: string): string =>
    documentScope('alice', 'workspace', itemId, 'note') ?? '';

  it('rejects a late write after sign-out and does not expose another account’s pending scopes', async () => {
    const journal = createDraftJournal(scope('late'), () => undefined);
    journal.append(update('Written before sign-out'));
    await journal.snapshot();
    expect(await listDraftScopes('alice')).toEqual([scope('late')]);
    expect(await listDraftScopes('bob')).toEqual([]);
    await sealItemBodies('alice', 'workspace', 'late');
    expect(await listDraftScopes('alice')).toEqual([scope('late')]);
    await expect(acknowledgeDrafts(await readDrafts(scope('late')))).rejects.toThrow('closed');
    expect(await readDrafts(scope('late'))).toHaveLength(1);
    await clearBodyCache();
    await expect(
      writeDraft({
        id: 'late',
        scope: scope('late'),
        revision: 1,
        update: update('After sign-out'),
      }),
    ).rejects.toThrow('closed');
  });

  it('lists duplicate draft records once per scope and only for the admitted account', async () => {
    for (const [id, itemId] of [
      ['one', 'same'],
      ['two', 'same'],
      ['three', 'other'],
    ] as const)
      await writeDraft({
        id,
        scope: scope(itemId),
        revision: 0,
        update: update(id),
      });
    await openBodyCache('bob');
    await writeDraft({
      id: 'bob-draft',
      scope: documentScope('bob', 'workspace', 'same', 'note') ?? '',
      revision: 0,
      update: update('Other account'),
    });
    await openBodyCache('alice');
    await sealItemBodies('alice', 'workspace', 'same');
    expect(await listDraftScopes('alice')).toEqual([scope('other'), scope('same')]);
    expect(await listDraftScopes('bob')).toEqual([]);
    expect(await readDrafts(scope('same'))).toHaveLength(2);
  });

  it('recovers more than 128 editor instances without discarding their updates', async () => {
    for (let index = 0; index < 129; index += 1)
      await writeDraft({
        id: String(index),
        scope: scope('many'),
        revision: 0,
        docId: 'doc',
        update: update(String(index)),
      });
    expect(await readDrafts(scope('many'))).toHaveLength(129);
  });
});
