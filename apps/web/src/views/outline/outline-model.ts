import type { Item } from '../../collections/core/container-model';

/** One visible row: the item, how deep it sits and where it is among its siblings. */
export interface OutlineRow {
  readonly item: Item;
  readonly level: number;
  readonly parentId: string | null;
  readonly siblings: readonly Item[];
  readonly index: number;
}

/** Where the "new item" field sits: under a parent, after a sibling (null for first). */
export interface Draft {
  readonly parentId: string | null;
  readonly afterId: string | null;
  readonly level: number;
}

/** A sentence about one row - a refused move, a locked branch - shown under that row. */
export interface RowNote {
  readonly itemId: string;
  readonly text: string;
}

export function titleOf(item: Item): string {
  return item.title.length > 0 ? item.title : 'Untitled';
}

export function without(set: ReadonlySet<string>, value: string): ReadonlySet<string> {
  if (!set.has(value)) return set;
  const next = new Set(set);
  next.delete(value);
  return next;
}
