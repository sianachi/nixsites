import { describe, expect, it } from 'vitest';

import { resolveOpenMode } from '../../../collections/core/open-policy';
import { aView } from '../../view-fixture';

describe('resolveOpenMode', () => {
  it('always opens a page on narrow screens, whatever the view says', () => {
    for (const open of [null, 'page', 'dialog', 'beside', 'tab', 'none', 'nonsense']) {
      expect(resolveOpenMode({ view: aView({ open }), narrow: true, canOpenBeside: true })).toBe(
        'page',
      );
    }
  });

  it('lets an explicit choice win over Auto', () => {
    expect(
      resolveOpenMode({
        view: aView({ kind: 'outline', open: 'dialog' }),
        narrow: false,
        canOpenBeside: false,
      }),
    ).toBe('dialog');
    expect(
      resolveOpenMode({
        view: aView({ kind: 'list', open: 'page' }),
        narrow: false,
        canOpenBeside: false,
      }),
    ).toBe('page');
  });

  it('opens a tab wherever there is room for one, regardless of a second pane', () => {
    expect(
      resolveOpenMode({ view: aView({ open: 'tab' }), narrow: false, canOpenBeside: false }),
    ).toBe('tab');
  });

  it('keeps none on wide screens, with or without room for a second pane', () => {
    for (const canOpenBeside of [true, false]) {
      expect(resolveOpenMode({ view: aView({ open: 'none' }), narrow: false, canOpenBeside })).toBe(
        'none',
      );
    }
  });

  it('degrades beside to a dialog when no second pane can open', () => {
    expect(
      resolveOpenMode({ view: aView({ open: 'beside' }), narrow: false, canOpenBeside: true }),
    ).toBe('beside');
    expect(
      resolveOpenMode({ view: aView({ open: 'beside' }), narrow: false, canOpenBeside: false }),
    ).toBe('dialog');
  });

  it('treats null, unknown tokens and no view as Auto', () => {
    expect(resolveOpenMode({ view: null, narrow: false, canOpenBeside: true })).toBe('dialog');
    expect(
      resolveOpenMode({
        view: aView({ open: 'later-build-token' }),
        narrow: false,
        canOpenBeside: true,
      }),
    ).toBe('dialog');
    expect(
      resolveOpenMode({ view: aView({ kind: 'outline' }), narrow: false, canOpenBeside: true }),
    ).toBe('page');
    expect(
      resolveOpenMode({ view: aView({ kind: 'sheet' }), narrow: false, canOpenBeside: true }),
    ).toBe('dialog');
  });
});
