import { describe, expect, it } from 'vitest';

import { VIEW_CAPABILITIES, capabilitiesOf } from '@nix/web-collections/core/view-capabilities';
import { VIEW_KINDS } from '@nix/web-views/core/view-kinds';

describe('view capabilities', () => {
  it('names every kind the registry can draw', () => {
    for (const descriptor of VIEW_KINDS) {
      expect(VIEW_CAPABILITIES, descriptor.kind).toHaveProperty(descriptor.kind);
    }
  });

  it('keeps query rows where they live', () => {
    expect(capabilitiesOf('query').move).toBe(false);
    expect(capabilitiesOf(undefined).move).toBe(true);
  });

  it('offers item actions only where these views render individual items', () => {
    expect(capabilitiesOf('habit_tracker')).toMatchObject({
      select: true,
      move: true,
      delete: true,
    });
    expect(capabilitiesOf('chart')).toMatchObject({
      select: false,
      move: false,
      delete: false,
    });
    expect(capabilitiesOf('form')).toMatchObject({
      select: false,
      move: false,
      delete: false,
    });
  });

  /** The matrix in docs/site/nix-docs/markdown/features/items-and-views.md is this table. */
  it('matches the documented capability matrix', () => {
    const rows = Object.entries(VIEW_CAPABILITIES).map(
      ([kind, caps]) =>
        `| ${kind} | ${caps.select ? 'yes' : 'no'} | ${caps.move ? 'yes' : 'no'} | ${caps.rename ? 'yes' : 'no'} | ${caps.delete ? 'yes' : 'no'} | ${caps.drag ?? 'none'} |`,
    );
    expect(rows).toMatchSnapshot();
  });
});
