import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SORT_DIRECTION,
  parseDirection,
  parseFilters,
  parseViewState,
} from '../../../collections/core/view-state';

/**
 * The view's state, read out of a query string.
 *
 * These are the parsers rather than the hook, so they can be exercised without a router. What they
 * protect is the claim the exit criterion makes: a shared link reproduces what the sender was
 * looking at. Everything that decides that is here.
 */

describe('the sort direction', () => {
  it('reads a direction the URL names', () => {
    expect(parseDirection('descending')).toBe('descending');
    expect(parseDirection('ascending')).toBe('ascending');
  });

  it('defaults when the URL names none', () => {
    expect(parseDirection(null)).toBe(DEFAULT_SORT_DIRECTION);
  });

  it('falls back and says so when the URL names something else', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // An unparseable parameter usually means a link we generated somewhere else has drifted, which
    // is worth knowing about rather than silently correcting.
    expect(parseDirection('sideways')).toBe(DEFAULT_SORT_DIRECTION);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });
});

describe('filters', () => {
  it('reads one value', () => {
    const filters = parseFilters(new URLSearchParams('f.status=Doing'));

    expect(filters).toEqual([{ propertyKey: 'status', values: ['Doing'] }]);
  });

  it('collects repeated parameters into one filter', () => {
    // Repeating the parameter rather than packing values into one is what makes a link readable
    // and makes adding a value an append rather than a parse-and-rewrite of an encoding of ours.
    const filters = parseFilters(new URLSearchParams('f.status=Doing&f.status=Done'));

    expect(filters).toEqual([{ propertyKey: 'status', values: ['Doing', 'Done'] }]);
  });

  it('keeps filters on different properties apart', () => {
    const filters = parseFilters(new URLSearchParams('f.status=Doing&f.owner=Ada'));

    expect(filters).toEqual([
      { propertyKey: 'status', values: ['Doing'] },
      { propertyKey: 'owner', values: ['Ada'] },
    ]);
  });

  it('ignores parameters that are not filters', () => {
    const filters = parseFilters(new URLSearchParams('view=board&sort=title&f.status=Doing'));

    expect(filters).toEqual([{ propertyKey: 'status', values: ['Doing'] }]);
  });

  it('ignores a filter with no property name and one with no value', () => {
    expect(parseFilters(new URLSearchParams('f.=Doing&f.status='))).toEqual([]);
  });
});

describe('the whole view state', () => {
  it('reads everything a shared link carries', () => {
    const state = parseViewState(
      new URLSearchParams('view=by-status&mode=week&sort=owner&dir=descending&f.status=Doing'),
    );

    // The exit criterion in one assertion: the view, the grain it is looked at in, its sort and its
    // filters all survive being pasted into a message.
    expect(state).toEqual({
      viewId: 'by-status',
      mode: 'week',
      sortBy: 'owner',
      direction: 'descending',
      filters: [{ propertyKey: 'status', values: ['Doing'] }],
      search: '',
    });
  });

  it('reads an empty query string as no opinion at all', () => {
    const state = parseViewState(new URLSearchParams());

    // Null rather than a default view id, because the container's own first view is the fallback
    // and this parser does not know what that is.
    expect(state.viewId).toBeNull();
    expect(state.sortBy).toBeNull();
    expect(state.filters).toEqual([]);
  });

  it('treats an empty view or sort parameter as absent', () => {
    const state = parseViewState(new URLSearchParams('view=&sort='));

    expect(state.viewId).toBeNull();
    expect(state.sortBy).toBeNull();
  });

  it('reads title search independently in each pane', () => {
    const params = new URLSearchParams('search=Water+plants&search2=Read');
    expect(parseViewState(params).search).toBe('Water plants');
    expect(parseViewState(params, 1).search).toBe('Read');
  });
});
