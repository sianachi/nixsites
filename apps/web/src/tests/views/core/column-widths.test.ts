import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clampWidth,
  readColumnWidths,
  resetColumnWidth,
  setColumnWidth,
} from '../../../views/core/column-widths';
import { memoryStorage } from '@nix/web-foundation/testing/memory-storage';

let viewId = 0;
let storage: Storage;
beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
  viewId += 1;
});

describe('column widths', () => {
  it('persists a dragged width per view and forgets it on reset', () => {
    const id = `view-${String(viewId)}`;
    setColumnWidth(id, 'status', 200);
    expect(readColumnWidths(id)).toEqual({ status: 200 });
    expect(JSON.parse(storage.getItem(`nix.view.column-widths:${id}`) ?? '{}')).toEqual({
      status: 200,
    });
    resetColumnWidth(id, 'status');
    expect(readColumnWidths(id)).toEqual({});
    expect(storage.getItem(`nix.view.column-widths:${id}`)).toBeNull();
  });

  it('clamps to the rails and ignores malformed storage rather than failing the view', () => {
    const id = `view-${String(viewId)}`;
    expect(clampWidth(10)).toBe(64);
    expect(clampWidth(5000)).toBe(800);
    expect(clampWidth(Number.NaN)).toBe(64);
    storage.setItem(`nix.view.column-widths:${id}`, '{not json');
    expect(readColumnWidths(id)).toEqual({});
    storage.setItem(
      `nix.view.column-widths:${id}-b`,
      JSON.stringify({ ok: 120, bad: 'wide', huge: 9000 }),
    );
    expect(readColumnWidths(`${id}-b`)).toEqual({ ok: 120, huge: 800 });
  });
});
