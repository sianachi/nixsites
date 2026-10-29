import { describe, expect, it } from 'vitest';

import { registerViews } from '../../../register-views';
import { VIEW_KINDS, findViewKind } from '../../../views/core/view-kinds';

/**
 * The kinds register themselves at start-up, and the test setup runs the app's own bootstrap
 * (`registerViews`). A kind that bootstrap forgot fails silently in the product: the item screen
 * says it cannot draw the view, the configuration panel is empty, the switcher borrows the list
 * icon. So the registered set and its order are pinned here.
 *
 * There is no closed kind union in the web app (`View.kind` is an open string); this is the set
 * Core stores, in the order the view picker offered it before the kinds registered themselves.
 */
const KINDS_IN_PICKER_ORDER = [
  'chat',
  'list',
  'board',
  'calendar',
  'gallery',
  'timeline',
  'sheet',
  'form',
  'query',
  'interactive_form',
  'chart',
  'habit_tracker',
  'finance',
  'drive',
  'checklist',
  'matrix',
  'outline',
  'custom',
];

describe('the view-kind bootstrap', () => {
  it('registers every kind, in the picker order', () => {
    expect(VIEW_KINDS.map((descriptor) => descriptor.kind)).toEqual(KINDS_IN_PICKER_ORDER);
  });

  it('wires the kind-specific seams the shared chrome reads', () => {
    // A container with no views draws as a list.
    expect(findViewKind('list')?.renderUnconfigured).toBeTypeOf('function');
    for (const kind of ['chart', 'checklist', 'interactive_form']) {
      expect(findViewKind(kind)?.configurationEditor).toBeTypeOf('function');
    }
  });

  it('refuses a second bootstrap', () => {
    expect(() => {
      registerViews();
    }).toThrow('The "chat" view kind is already registered.');
    expect(VIEW_KINDS).toHaveLength(KINDS_IN_PICKER_ORDER.length);
  });
});
