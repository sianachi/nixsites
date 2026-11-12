import { item } from '@nix/web-foundation/testing/api-stub';
import { expect, it } from 'vitest';
import { DEPENDENCY_KEY, dependsOn, previewDependencyDates } from '../../items/dependency-dates';

it('preserves duration and propagates a delay through dated prerequisites', () => {
  const design = item({
    id: 'design',
    title: 'Design',
    properties: { start: '2026-11-10', end: '2026-11-12' },
  });
  const build = item({
    id: 'build',
    title: 'Build',
    properties: { start: '2026-11-12', end: '2026-11-14', [DEPENDENCY_KEY]: design.id },
  });
  const ship = item({
    id: 'ship',
    title: 'Ship',
    properties: { start: '2026-11-15', [DEPENDENCY_KEY]: build.id },
  });
  const other = item({ id: 'other', title: 'Other', properties: { start: '2026-11-15' } });
  const items = [design, build, ship, other];

  expect(
    previewDependencyDates(design.id, '2026-11-15', items, 'start', 'end').map(
      ({ item: row, before, after }) => [row.title, before, after],
    ),
  ).toEqual([
    ['Design', '2026-11-10', '2026-11-15'],
    ['Build', '2026-11-12', '2026-11-17'],
    ['Ship', '2026-11-15', '2026-11-19'],
  ]);
  expect(dependsOn(ship.id, design.id, new Map(items.map((row) => [row.id, row])))).toBe(true);
});
