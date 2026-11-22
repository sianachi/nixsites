import { expect, test } from 'vitest';

import { candidates, match } from './run';

const guid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (n: number, parent: number | null, id = guid(n)) =>
  ({
    id,
    parentId: parent === null ? null : guid(parent),
    type: 'note',
    lifecycleState: 'active',
    locked: false,
    metadataExpiresAt: null,
    properties: {},
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: null,
  }) as never;

test('descendant scope follows ancestors, is case-insensitive on the target', () => {
  // 1 <- 2 <- 3 <- 4
  const all = [
    item(1, null),
    item(2, 1),
    item(3, 2),
    item(4, 3),
    item(5, 9),
    item(6, 7),
    item(7, 6),
  ];
  const { rows, byId } = candidates(all, new Date());
  const ids = (target: number) =>
    match(rows, byId, {
      rules: [],
      order: {} as never,
      today: 0,
      zone: null,
      scope: { parentId: guid(target).toUpperCase(), descendants: true },
    }).map((row) => row.item.id);
  expect(ids(1)).toEqual([guid(2), guid(3), guid(4)]);
  expect(ids(2)).toEqual([guid(3), guid(4)]);
  expect(ids(4)).toEqual([]);
});
