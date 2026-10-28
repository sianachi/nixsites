import { describe, expect, it, vi } from 'vitest';

import {
  TAB_TRANSFER_MIME,
  carriesTabTransfer,
  planTabTransfer,
  readTabTransfer,
  writeTabTransfer,
  type TabTransferPayload,
} from '../../tabs/tab-transfer';
import type { OpenTab } from '../../lib/tab-store';

const ALPHA = '0a0a0a0a-0000-4000-8000-00000000000a';
const BRAVO = '0b0b0b0b-0000-4000-8000-00000000000b';
const CHARLIE = '0c0c0c0c-0000-4000-8000-00000000000c';
const DELTA = '0d0d0d0d-0000-4000-8000-00000000000d';

function payload(itemId: string, sourcePane: number): TabTransferPayload {
  return { version: 1, itemId, sourcePane };
}

function plan(
  search: string,
  byPane: Readonly<Record<number, readonly OpenTab[]>>,
  move: TabTransferPayload,
  destinationPane: number,
  visiblePaneIndexes: readonly number[] = [0, 1, 2],
) {
  return planTabTransfer({
    params: new URLSearchParams(search),
    byPane,
    visiblePaneIndexes,
    payload: move,
    destinationPane,
  });
}

describe('the tab drag payload', () => {
  it('uses only Nix’s private MIME type and round-trips a versioned payload', () => {
    const values = new Map<string, string>();
    const setData = vi.fn((type: string, value: string) => values.set(type, value));
    const getData = vi.fn((type: string) => values.get(type) ?? '');
    const transfer = {
      effectAllowed: 'all',
      types: [TAB_TRANSFER_MIME],
      setData,
      getData,
    } as unknown as DataTransfer;

    writeTabTransfer(transfer, payload(ALPHA, 1));

    expect(transfer.effectAllowed).toBe('move');
    expect(setData).toHaveBeenCalledOnce();
    expect(setData).toHaveBeenCalledWith(TAB_TRANSFER_MIME, expect.any(String));
    expect(readTabTransfer(transfer)).toEqual(payload(ALPHA, 1));
    expect(carriesTabTransfer(transfer)).toBe(true);
  });

  it('refuses malformed, unversioned and unrelated drops', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const transfer = {
      types: ['text/plain'],
      getData: vi.fn(() => '{not json'),
    } as unknown as DataTransfer;
    expect(carriesTabTransfer(transfer)).toBe(false);
    expect(readTabTransfer(transfer)).toBeNull();
    expect(warn).not.toHaveBeenCalled();

    const malformed = {
      types: [TAB_TRANSFER_MIME],
      getData: vi.fn(() => JSON.stringify({ itemId: ALPHA, sourcePane: 0 })),
    } as unknown as DataTransfer;
    expect(readTabTransfer(malformed)).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      'Ignoring malformed Nix tab transfer payload.',
      expect.any(Object),
    );
    warn.mockRestore();
  });
});

describe('planning a cross-pane tab move', () => {
  it('moves a background tab, preserves both active strips, and pins the deliberate move', () => {
    const result = plan(
      `item=${ALPHA}&view=board&f.status=open&item2=${BRAVO}&view2=calendar&f2.owner=ada&sizes=60,40&split=h`,
      {
        0: [
          { itemId: ALPHA, pinned: true },
          { itemId: CHARLIE, pinned: false },
        ],
      },
      payload(CHARLIE, 0),
      1,
      [0, 1],
    );

    expect(result.refusal).toBeNull();
    expect(result.plan?.nextParams.get('item')).toBe(ALPHA);
    expect(result.plan?.nextParams.get('view')).toBe('board');
    expect(result.plan?.nextParams.getAll('f.status')).toEqual(['open']);
    expect(result.plan?.nextParams.get('item2')).toBe(CHARLIE);
    expect(result.plan?.nextParams.has('view2')).toBe(false);
    expect(result.plan?.nextParams.has('f2.owner')).toBe(false);
    expect(result.plan?.nextParams.get('sizes')).toBe('60,40');
    expect(result.plan?.nextParams.get('split')).toBe('h');
    expect(result.plan?.nextByPane).toEqual({
      0: [{ itemId: ALPHA, pinned: true }],
      1: [
        { itemId: BRAVO, pinned: false },
        { itemId: CHARLIE, pinned: true },
      ],
    });
  });

  it('shows the immediate-left source neighbor when the moved active tab has tabs left', () => {
    const result = plan(
      `item=${BRAVO}&view=board&item2=${DELTA}&view2=calendar&sizes=55,45`,
      {
        0: [
          { itemId: ALPHA, pinned: true },
          { itemId: BRAVO, pinned: true },
          { itemId: CHARLIE, pinned: true },
        ],
        1: [{ itemId: DELTA, pinned: true }],
      },
      payload(BRAVO, 0),
      1,
      [0, 1],
    );

    expect(result.plan?.sourceClosed).toBe(false);
    expect(result.plan?.nextParams.get('item')).toBe(ALPHA);
    expect(result.plan?.nextParams.has('view')).toBe(false);
    expect(result.plan?.nextParams.get('item2')).toBe(BRAVO);
    expect(result.plan?.nextParams.has('view2')).toBe(false);
    expect(result.plan?.nextParams.get('sizes')).toBe('55,45');
    expect(result.plan?.nextByPane[0]).toEqual([
      { itemId: ALPHA, pinned: true },
      { itemId: CHARLIE, pinned: true },
    ]);
  });

  it('falls back to the right neighbor when the first active tab moves', () => {
    const result = plan(
      `item=${ALPHA}&item2=${DELTA}`,
      {
        0: [
          { itemId: ALPHA, pinned: true },
          { itemId: BRAVO, pinned: true },
        ],
        1: [{ itemId: DELTA, pinned: true }],
      },
      payload(ALPHA, 0),
      1,
      [0, 1],
    );

    expect(result.plan?.sourceClosed).toBe(false);
    expect(result.plan?.nextParams.get('item')).toBe(BRAVO);
    expect(result.plan?.nextParams.get('item2')).toBe(ALPHA);
  });

  it('closes a first source pane, shifts a third-pane target, and retains synthesized actives', () => {
    const result = plan(
      `item=${ALPHA}&view=board&item2=${BRAVO}&view2=list&f2.owner=ada&item3=${CHARLIE}&view3=calendar&sizes=20,30,50&split=h&keep=yes`,
      {},
      payload(ALPHA, 0),
      2,
    );

    expect(result.plan?.sourceClosed).toBe(true);
    expect(result.plan?.finalDestinationPane).toBe(1);
    expect(result.plan?.nextParams.get('item')).toBe(BRAVO);
    expect(result.plan?.nextParams.get('view')).toBe('list');
    expect(result.plan?.nextParams.getAll('f.owner')).toEqual(['ada']);
    expect(result.plan?.nextParams.get('item2')).toBe(ALPHA);
    expect(result.plan?.nextParams.has('view2')).toBe(false);
    expect(result.plan?.nextParams.has('item3')).toBe(false);
    expect(result.plan?.nextParams.has('sizes')).toBe(false);
    expect(result.plan?.nextParams.get('split')).toBe('h');
    expect(result.plan?.nextParams.get('keep')).toBe('yes');
    expect(result.plan?.nextByPane).toEqual({
      0: [{ itemId: BRAVO, pinned: false }],
      1: [
        { itemId: CHARLIE, pinned: false },
        { itemId: ALPHA, pinned: true },
      ],
    });
  });

  it('closes a last source pane without renumbering an earlier target', () => {
    const result = plan(
      `item=${ALPHA}&item2=${BRAVO}&item3=${CHARLIE}&sizes=30,30,40`,
      {},
      payload(CHARLIE, 2),
      0,
    );

    expect(result.plan?.finalDestinationPane).toBe(0);
    expect(result.plan?.nextParams.get('item')).toBe(CHARLIE);
    expect(result.plan?.nextParams.get('item2')).toBe(BRAVO);
    expect(result.plan?.nextParams.has('item3')).toBe(false);
    expect(result.plan?.nextByPane).toEqual({
      0: [
        { itemId: ALPHA, pinned: false },
        { itemId: CHARLIE, pinned: true },
      ],
      1: [{ itemId: BRAVO, pinned: false }],
    });
  });

  it('closes a middle source pane and shifts its later destination into that index', () => {
    const result = plan(
      `item=${ALPHA}&item2=${BRAVO}&item3=${CHARLIE}&sizes=30,30,40`,
      {},
      payload(BRAVO, 1),
      2,
    );

    expect(result.plan?.sourceClosed).toBe(true);
    expect(result.plan?.finalDestinationPane).toBe(1);
    expect(result.plan?.nextParams.get('item')).toBe(ALPHA);
    expect(result.plan?.nextParams.get('item2')).toBe(BRAVO);
    expect(result.plan?.nextParams.has('item3')).toBe(false);
    expect(result.plan?.nextByPane).toEqual({
      0: [{ itemId: ALPHA, pinned: false }],
      1: [
        { itemId: CHARLIE, pinned: false },
        { itemId: BRAVO, pinned: true },
      ],
    });
  });

  it('removes every stale copy while installing one destination owner', () => {
    const result = plan(
      `item=${ALPHA}&item2=${BRAVO}`,
      {
        0: [
          { itemId: ALPHA, pinned: true },
          { itemId: CHARLIE, pinned: true },
        ],
        1: [
          { itemId: BRAVO, pinned: true },
          { itemId: CHARLIE, pinned: true },
        ],
        8: [{ itemId: CHARLIE, pinned: true }],
      },
      payload(CHARLIE, 0),
      1,
      [0, 1],
    );

    expect(
      Object.values(result.plan?.nextByPane ?? {}).flatMap((tabs) =>
        tabs.filter((tab) => tab.itemId === CHARLIE),
      ),
    ).toEqual([{ itemId: CHARLIE, pinned: true }]);
  });

  it('refuses self, hidden and stale transfers without planning a mutation', () => {
    const search = `item=${ALPHA}&item2=${BRAVO}`;
    expect(plan(search, {}, payload(ALPHA, 0), 0, [0, 1]).refusal).toBe('same-pane');
    expect(plan(search, {}, payload(BRAVO, 1), 0, [0]).refusal).toBe('hidden-pane');
    expect(plan(search, {}, payload(CHARLIE, 0), 1, [0, 1]).refusal).toBe('stale-tab');
    expect(plan(`item=${ALPHA}&item2=${ALPHA}`, {}, payload(ALPHA, 1), 0, [0, 1]).refusal).toBe(
      'stale-tab',
    );
  });
});
