import { describe, expect, it } from 'vitest';

import type { PropertyDefinition } from '@nix/web-collections/core/container-model';
import {
  VIEW_KINDS,
  findViewKind,
  isKnownViewKind,
  type ViewConfiguration,
} from '../../../views/core/view-kinds';

/**
 * The registry that makes adding a view kind one entry.
 *
 * These tests are about the *table*, not about any one kind. What they protect is the property the
 * table exists for: that a kind declared here is complete everywhere the application needs it, and
 * that a kind not declared here is refused rather than approximated.
 */

/** A property definition to ask a configuration's `accepts` about, retyped per assertion. */
const STATUS: PropertyDefinition = {
  key: 'status',
  label: 'Status',
  type: 'select',
  options: ['Open', 'Done'],
  required: false,
};

/** Every configuration a kind offers, in the order the editor draws them. */
function configurations(kind: string): readonly ViewConfiguration[] {
  return findViewKind(kind)?.configures ?? [];
}

/** The single configuration a kind has, when the assertion is about that one. */
function onlyConfiguration(kind: string): ViewConfiguration {
  const [first, ...rest] = findViewKind(kind)?.configures ?? [];

  // Checked rather than indexed blindly: a kind that grew a second configuration would otherwise
  // make every assertion using this quietly about whichever one happened to be first.
  if (first === undefined || rest.length > 0) {
    throw new Error(`"${kind}" does not have exactly one configuration.`);
  }

  return first;
}

describe('the view-kind registry', () => {
  it('knows the eighteen this build can draw', () => {
    // The count keeps the test's name honest: a kind added without updating this sentence fails
    // here rather than leaving a name that undercounts.
    expect(VIEW_KINDS).toHaveLength(18);
    expect(isKnownViewKind('habit_tracker')).toBe(true);
    expect(isKnownViewKind('list')).toBe(true);
    expect(isKnownViewKind('board')).toBe(true);
    expect(isKnownViewKind('calendar')).toBe(true);
    expect(isKnownViewKind('gallery')).toBe(true);
    expect(isKnownViewKind('timeline')).toBe(true);
    expect(isKnownViewKind('sheet')).toBe(true);
    expect(isKnownViewKind('form')).toBe(true);
    expect(isKnownViewKind('query')).toBe(true);
    expect(isKnownViewKind('interactive_form')).toBe(true);
    expect(isKnownViewKind('chart')).toBe(true);
    expect(isKnownViewKind('drive')).toBe(true);
    expect(isKnownViewKind('finance')).toBe(true);
    expect(isKnownViewKind('checklist')).toBe(true);
    expect(isKnownViewKind('matrix')).toBe(true);
    expect(isKnownViewKind('outline')).toBe(true);
    expect(isKnownViewKind('chat')).toBe(true);
    expect(isKnownViewKind('custom')).toBe(true);
  });

  it('does not claim to know a kind from a newer build', () => {
    // The item screen explains such a view rather than drawing an empty one, which is only possible
    // because this returns false rather than guessing. The dispatch it replaced had a `default`
    // arm, so an unknown kind was silently drawn as a list.
    expect(isKnownViewKind('canvas')).toBe(false);
    expect(findViewKind('canvas')).toBeNull();
  });

  it('gives every kind everything a caller needs', () => {
    // The point of one entry per kind is that the entry is complete. A descriptor missing its icon
    // or its renderer would fail at the point of use - in a switcher tab, or mid-render - rather
    // than here.
    for (const descriptor of VIEW_KINDS) {
      expect(descriptor.kind.length).toBeGreaterThan(0);
      expect(descriptor.label.length).toBeGreaterThan(0);
      expect(descriptor.icon).toBeDefined();
      expect(typeof descriptor.render).toBe('function');
    }
  });

  it('gives no two kinds the same stored name', () => {
    // Two entries sharing a name would make the lookup return whichever came first, so one kind
    // would quietly render as the other.
    const names = VIEW_KINDS.map((descriptor) => descriptor.kind);

    expect(new Set(names).size).toBe(names.length);
  });

  it('describes what each configurable kind needs, and what needs nothing', () => {
    // A list needs nothing: with no columns configured it falls back to the effective schema, and
    // with no schema at all it still has titles to show. Its one configuration is optional - the
    // sections - which is why its empty choice reads "None" rather than asking for a property. The
    // spreadsheet view needs nothing by the same argument - its columns resolve exactly as the
    // list's do.
    expect(onlyConfiguration('list').field).toBe('groupBy');
    expect(onlyConfiguration('list').emptyChoice).toBe('None');
    expect(onlyConfiguration('list').extraChoices?.map((choice) => choice.value)).toEqual([
      '$type',
    ]);
    expect(onlyConfiguration('list').accepts({ ...STATUS, type: 'checkbox' })).toBe(true);
    expect(onlyConfiguration('list').accepts({ ...STATUS, type: 'text' })).toBe(false);
    expect(findViewKind('sheet')?.configures).toEqual([]);
    expect(findViewKind('form')?.configures).toEqual([]);

    expect(onlyConfiguration('board').field).toBe('groupBy');
    expect(onlyConfiguration('gallery').field).toBe('coverProperty');

    // The calendar is the second kind configured from two properties, alongside the timeline
    // below - it shares the timeline's own field names for the same reason `endDateProperty`'s
    // own comment gives: switching a view between the two kinds carries the pair across untouched.
    expect(configurations('calendar').map((entry) => entry.field)).toEqual([
      'dateProperty',
      'endDateProperty',
    ]);

    // The kind the array shape was written for. This asserts the table; that the editor actually
    // draws two blocks from it is asserted where it happens, in `view-editor.test.tsx` - a claim
    // about a form is not provable from the data the form reads.
    expect(configurations('timeline').map((entry) => entry.field)).toEqual([
      'dateProperty',
      'endDateProperty',
    ]);
  });

  it('holds a list of configurations rather than one, so a kind may need two properties', () => {
    // The shape, not any one kind. The table's stated purpose is that adding a kind is one entry,
    // and a single-slot shape would have made the next kind that needs a second property - a
    // timeline, which needs a start and an end - a change to this type and to every reader of it.
    for (const descriptor of VIEW_KINDS) {
      expect(Array.isArray(descriptor.configures)).toBe(true);
    }
  });

  it('words the empty choice as what it means for that kind', () => {
    // A board with no grouping property has no columns and says so instead of drawing, so its
    // empty option is an instruction. A gallery with no cover property is a grid of titled cards,
    // so "Choose a property" would read as an unfinished view and send somebody looking for the
    // fault. The registry holds the copy rather than a flag the editor translates, so this asserts
    // wording rather than the presence of a key.
    expect(onlyConfiguration('gallery').emptyChoice).toBe('None');
    expect(onlyConfiguration('board').emptyChoice).toBe('Choose a property');

    // A timeline is both at once, which is exactly why the copy lives here rather than being
    // derived from the kind: without a start there is no position, and without an end every item is
    // a milestone - which is a finished timeline, not a broken one.
    const [start, end] = configurations('timeline');
    expect(start?.emptyChoice).toBe('Choose a property');
    expect(end?.emptyChoice).toBe('None');

    // A calendar draws the same pair the same way: waiting on a place to put an item, complete
    // without a length for it.
    const [calendarStart, calendarEnd] = configurations('calendar');
    expect(calendarStart?.emptyChoice).toBe('Choose a property');
    expect(calendarEnd?.emptyChoice).toBe('None');
  });

  it('lets each kind be configured only from the property types it can use', () => {
    // This is the same rule the server enforces on write. Offering a property the kind cannot use
    // would let somebody build a view that stores fine and then refuses to draw.
    const board = onlyConfiguration('board');
    const [calendar] = configurations('calendar');
    const gallery = onlyConfiguration('gallery');

    if (calendar === undefined) {
      throw new Error('"calendar" lost its first configuration.');
    }

    const select = {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: ['Doing'],
      required: false,
    };
    const date = { key: 'due', label: 'Due', type: 'date', options: [], required: false };
    const text = { key: 'note', label: 'Note', type: 'text', options: [], required: false };
    const image = { key: 'shot', label: 'Shot', type: 'image', options: [], required: false };
    const url = { key: 'source', label: 'Source', type: 'url', options: [], required: false };

    expect(board.accepts(select)).toBe(true);
    expect(board.accepts(date)).toBe(false);
    expect(board.accepts(text)).toBe(false);

    expect(calendar.accepts(date)).toBe(true);
    expect(calendar.accepts(select)).toBe(false);

    expect(gallery.accepts(image)).toBe(true);

    // A link is not a picture. They hold the same sort of text and are read completely differently
    // - one is clicked, the other is fetched and drawn without anybody deciding to - so a gallery
    // offering every link in the workspace as a cover would be offering the wrong thing.
    expect(gallery.accepts(url)).toBe(false);
    expect(gallery.accepts(text)).toBe(false);

    // Both ends of a span take the same types the calendar takes, because the server's requirement
    // for a timeline is the calendar's verbatim. A form offering more than the server accepts would
    // let somebody build a view that saves and then refuses to draw.
    for (const configuration of configurations('timeline')) {
      expect(configuration.accepts(date)).toBe(true);
      expect(configuration.accepts(text)).toBe(false);
      expect(configuration.accepts(select)).toBe(false);
    }

    // The calendar's own second field, `endDateProperty`, takes the same types its first field
    // does - a person is not offered a "End" property the server would refuse to store beside a
    // stored `dateProperty`.
    for (const configuration of configurations('calendar')) {
      expect(configuration.accepts(date)).toBe(true);
      expect(configuration.accepts(text)).toBe(false);
      expect(configuration.accepts(select)).toBe(false);
    }
  });

  it('clears the column order when a board changes the property it groups by', () => {
    // The order belonged to the old property. Carried across, it would filter the new one down to
    // values it does not have, and the board would draw empty.
    expect(onlyConfiguration('board').clears).toEqual({ groupOrder: [] });

    // A gallery has nothing that outlives its property, so it clears nothing.
    expect(onlyConfiguration('gallery').clears).toBeUndefined();

    // Neither does the calendar's pair, for the same reason as the timeline's own below: the start
    // is `dateProperty` under a name a switch to or from a timeline has to carry across untouched.
    for (const configuration of configurations('calendar')) {
      expect(configuration.clears).toBeUndefined();
    }

    // Neither does a timeline, and here it is load-bearing rather than incidental: the start is the
    // calendar's own `dateProperty`, so clearing anything on a switch between the two kinds would
    // be the thing that made the switch lossy.
    for (const configuration of configurations('timeline')) {
      expect(configuration.clears).toBeUndefined();
    }
  });
});
