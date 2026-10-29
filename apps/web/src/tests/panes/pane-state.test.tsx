import { act, renderHook } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate, useSearchParams } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';
import { parseFilters, parseViewState } from '../../collections/core/view-state';
import { closePaneParams, parsePanes, usePanes } from '@nix/web-platform/panes/pane-state';
import {
  PANE_LIMIT,
  clearViewState,
  paneFilterPrefix,
  paneParam,
  parseSizes,
  parseSplit,
  sizesToParam,
} from '@nix/web-platform/panes/pane-params';

/**
 * The arrangement, read out of a query string.
 *
 * The parsers rather than the hook, so they run without a router. What they protect is the claim
 * the URL grammar makes: a link reproduces the arrangement its sender was looking at, and pane one
 * still means what it meant before panes existed.
 */

describe('the parameter names', () => {
  it('leaves the first pane exactly as it was', () => {
    // The compatibility promise. Every link anybody has been sent addresses these names, and a
    // suffix on the first pane would have broken all of them at once.
    expect(paneParam('item', 0)).toBe('item');
    expect(paneParam('view', 0)).toBe('view');
    expect(paneFilterPrefix(0)).toBe('f.');
  });

  it('gives later panes a one-based suffix', () => {
    expect(paneParam('item', 1)).toBe('item2');
    expect(paneParam('view', 2)).toBe('view3');
    expect(paneFilterPrefix(1)).toBe('f2.');
  });

  it('keeps one pane’s filters from matching another’s prefix', () => {
    // Why the second pane is `f2.` and not `f.2.`: the existing reader is a single `startsWith`,
    // and it has to separate the panes rather than see one as a prefix of the other.
    expect(paneFilterPrefix(1).startsWith(paneFilterPrefix(0))).toBe(false);
    expect(paneFilterPrefix(0).startsWith(paneFilterPrefix(1))).toBe(false);
  });
});

describe('reading an arrangement', () => {
  const first = '00000000-0000-4000-8000-000000000001';
  const second = '00000000-0000-4000-8000-000000000002';
  const third = '00000000-0000-4000-8000-000000000003';

  it('reads one pane from the address every existing link uses', () => {
    const { panes, split, sizes } = parsePanes(new URLSearchParams(`item=${first}`));

    expect(panes).toEqual([{ index: 0, itemId: first }]);
    expect(split).toBe('vertical');
    expect(sizes).toBeNull();
  });

  it('reads several panes in order', () => {
    const { panes } = parsePanes(
      new URLSearchParams(`item=${first}&item2=${second}&item3=${third}`),
    );

    expect(panes.map((pane) => pane.itemId)).toEqual([first, second, third]);
  });

  it('reads nothing when nothing is open', () => {
    expect(parsePanes(new URLSearchParams()).panes).toEqual([]);
  });

  it('stops at a gap rather than renumbering around it', () => {
    // `item3` with no `item2` describes an arrangement that cannot exist - a truncated or
    // hand-edited link. Closing the gap would open something the sender did not send.
    const { panes } = parsePanes(new URLSearchParams(`item=${first}&item3=${third}`));

    expect(panes.map((pane) => pane.itemId)).toEqual([first]);
  });

  it('drops a pane past the limit, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const query = [`item=${first}`, `item2=${second}`, `item3=${third}`, `item4=${first}`].join(
      '&',
    );
    const { panes } = parsePanes(new URLSearchParams(query));

    expect(panes).toHaveLength(PANE_LIMIT);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('drops a pane whose identifier is not one, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { panes } = parsePanes(new URLSearchParams(`item=${first}&item2=not-a-uuid`));

    expect(panes.map((pane) => pane.itemId)).toEqual([first]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('each pane’s view state', () => {
  it('reads only its own pane’s parameters', () => {
    const params = new URLSearchParams(
      'view=board&sort=owner&f.status=open&view2=calendar&sort2=due&f2.status=done',
    );

    expect(parseViewState(params, 0)).toMatchObject({ viewId: 'board', sortBy: 'owner' });
    expect(parseViewState(params, 1)).toMatchObject({ viewId: 'calendar', sortBy: 'due' });
    expect(parseFilters(params, 0)).toEqual([{ propertyKey: 'status', values: ['open'] }]);
    expect(parseFilters(params, 1)).toEqual([{ propertyKey: 'status', values: ['done'] }]);
  });

  it('reads nothing for a pane the address says nothing about', () => {
    const params = new URLSearchParams('view=board&sort=owner&f.status=open');

    expect(parseViewState(params, 1)).toMatchObject({ viewId: null, sortBy: null, filters: [] });
  });
});

describe('clearing one pane’s view state', () => {
  it('leaves every other pane untouched', () => {
    // The defect this whole refactor exists to prevent, and the one a naive port would have
    // shipped: `clearViewState` deleted the unprefixed names unconditionally, so navigating in
    // the second pane would silently discard the first pane's board, its sort and its filters -
    // a change to a part of the screen the person was not looking at.
    const params = new URLSearchParams(
      'view=board&sort=owner&dir=descending&f.status=open&view2=calendar&sort2=due&f2.status=done&search=first&search2=second',
    );

    clearViewState(params, 1);

    expect(params.get('view')).toBe('board');
    expect(params.get('sort')).toBe('owner');
    expect(params.get('dir')).toBe('descending');
    expect(params.getAll('f.status')).toEqual(['open']);
    expect(params.get('search')).toBe('first');

    expect(params.get('view2')).toBeNull();
    expect(params.get('sort2')).toBeNull();
    expect(params.getAll('f2.status')).toEqual([]);
    expect(params.get('search2')).toBeNull();
  });

  it('clears the first pane without touching the second', () => {
    const params = new URLSearchParams(
      'view=board&f.status=open&view2=calendar&f2.status=done&search=first&search2=second',
    );

    clearViewState(params, 0);

    expect(params.get('view')).toBeNull();
    expect(params.getAll('f.status')).toEqual([]);
    expect(params.get('search')).toBeNull();
    expect(params.get('view2')).toBe('calendar');
    expect(params.getAll('f2.status')).toEqual(['done']);
    expect(params.get('search2')).toBe('second');
  });

  it('defaults to the first pane, so every existing caller is unchanged', () => {
    const params = new URLSearchParams('view=board&f.status=open');

    clearViewState(params);

    expect(params.get('view')).toBeNull();
    expect(params.getAll('f.status')).toEqual([]);
  });
});

describe('the split orientation', () => {
  const first = '00000000-0000-4000-8000-000000000001';
  const second = '00000000-0000-4000-8000-000000000002';

  it('reads both spellings', () => {
    expect(parseSplit('h')).toBe('horizontal');
    expect(parseSplit('horizontal')).toBe('horizontal');
    expect(parseSplit('v')).toBe('vertical');
  });

  it('defaults when the address names none', () => {
    expect(parseSplit(null)).toBe('vertical');
  });

  it('falls back and says so when the address names something else', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(parseSplit('diagonal')).toBe('vertical');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('replaces only the layout parameter and keeps Back for the preceding navigation', () => {
    const editor =
      `/?item=${first}&view=board&f.status=open&item2=${second}` +
      '&view2=calendar&f2.owner=ada&sizes=60,40&keep=present';
    const { result } = renderHook(
      () => ({
        panes: usePanes(),
        params: useSearchParams()[0],
        location: useLocation(),
        navigate: useNavigate(),
      }),
      {
        wrapper: ({ children }) => (
          <MemoryRouter initialEntries={['/calendar', editor]} initialIndex={1}>
            {children}
          </MemoryRouter>
        ),
      },
    );

    act(() => {
      result.current.panes.setSplit('horizontal');
    });

    expect(result.current.params.get('split')).toBe('h');
    expect(result.current.params.get('item')).toBe(first);
    expect(result.current.params.get('view')).toBe('board');
    expect(result.current.params.getAll('f.status')).toEqual(['open']);
    expect(result.current.params.get('item2')).toBe(second);
    expect(result.current.params.get('view2')).toBe('calendar');
    expect(result.current.params.getAll('f2.owner')).toEqual(['ada']);
    expect(result.current.params.get('sizes')).toBe('60,40');
    expect(result.current.params.get('keep')).toBe('present');

    act(() => {
      void result.current.navigate(-1);
    });

    expect(result.current.location.pathname).toBe('/calendar');
  });
});

describe('the pane ratio', () => {
  it('reads one percentage per pane', () => {
    expect(parseSizes('62.5,37.5', 2)).toEqual([62.5, 37.5]);
  });

  it('is absent when the address says nothing', () => {
    expect(parseSizes(null, 2)).toBeNull();
  });

  it('discards a ratio that describes a different number of panes', () => {
    // Rescaling a two-pane ratio onto three would be inventing a layout nobody chose, and
    // guessing which two of the three it described is not something a reader should have to do.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(parseSizes('60,40', 3)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('discards a ratio with a value that is not a positive number', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(parseSizes('60,-10', 2)).toBeNull();
    expect(parseSizes('60,wide', 2)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('writes a ratio a person can read', () => {
    // A drag produces a float with a dozen decimal places, and none of them belong in a link.
    expect(sizesToParam([62.54321, 37.45679])).toBe('62.5,37.5');
  });

  it('round-trips what it writes', () => {
    const sizes = [62.5, 37.5];
    expect(parseSizes(sizesToParam(sizes), 2)).toEqual(sizes);
  });
});

describe('a pane showing the conversation', () => {
  const first = '00000000-0000-4000-8000-000000000001';
  const second = '00000000-0000-4000-8000-000000000002';

  it('reads a workspace or note scope per pane', () => {
    const { panes } = parsePanes(
      new URLSearchParams(`item=${first}&chat=workspace&item2=${second}&chat2=${first}`),
    );

    expect(panes).toEqual([
      { index: 0, itemId: first, chat: 'workspace' },
      { index: 1, itemId: second, chat: first },
    ]);
  });

  it('drops a scope that is neither, and ignores one with no item beside it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { panes } = parsePanes(new URLSearchParams(`item=${first}&chat=../x&chat2=workspace`));

    expect(panes).toEqual([{ index: 0, itemId: first }]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('moves down with its pane when an earlier one closes, and goes with its own', () => {
    const params = new URLSearchParams(
      `item=${first}&item2=${second}&chat2=workspace&item3=${first}&chat3=${second}`,
    );

    closePaneParams(params, 1, 3);

    expect(params.get('chat2')).toBe(second);
    expect(params.get('chat3')).toBeNull();
    expect(params.get('chat')).toBeNull();
  });
});

describe('closing a pane', () => {
  const first = '00000000-0000-4000-8000-000000000001';
  const second = '00000000-0000-4000-8000-000000000002';
  const third = '00000000-0000-4000-8000-000000000003';

  function arrangementOf(query: string): string[] {
    return parsePanes(new URLSearchParams(query)).panes.map((pane) => pane.itemId);
  }

  it('closes the last pane and leaves the rest alone', () => {
    const params = new URLSearchParams(`item=${first}&view=board&item2=${second}&view2=calendar`);

    closePaneParams(params, 1, 2);

    expect(arrangementOf(params.toString())).toEqual([first]);
    expect(params.get('view')).toBe('board');
    expect(params.get('view2')).toBeNull();
  });

  it('renumbers the panes after the one that closed', () => {
    // The failure this guards: leave `item` and `item3` behind and `parsePanes` stops at the gap,
    // so closing the middle pane would take the third one with it.
    const params = new URLSearchParams(
      `item=${first}&search=first&item2=${second}&search2=closed&item3=${third}&view3=calendar&f3.status=done&search3=third`,
    );

    closePaneParams(params, 1, 3);

    expect(arrangementOf(params.toString())).toEqual([first, third]);
    // The third pane's whole state moves down with it, not just its item.
    expect(params.get('view2')).toBe('calendar');
    expect(params.getAll('f2.status')).toEqual(['done']);
    expect(params.get('search')).toBe('first');
    expect(params.get('search2')).toBe('third');
    expect(params.get('search3')).toBeNull();
    expect(params.get('view3')).toBeNull();
    expect(params.get('item3')).toBeNull();
  });

  it('carries a pane’s filters down without merging them into the pane below', () => {
    const params = new URLSearchParams(
      `item=${first}&f.status=open&item2=${second}&f2.status=done&item3=${third}&f3.owner=ada`,
    );

    closePaneParams(params, 1, 3);

    expect(params.getAll('f.status')).toEqual(['open']);
    expect(params.getAll('f2.owner')).toEqual(['ada']);
    expect(params.getAll('f2.status')).toEqual([]);
  });

  it('drops a ratio that no longer describes the panes', () => {
    const params = new URLSearchParams(`item=${first}&item2=${second}&sizes=60,40`);

    closePaneParams(params, 1, 2);

    expect(params.get('sizes')).toBeNull();
  });
});

describe('a window too narrow to hold a second pane', () => {
  const first = '00000000-0000-4000-8000-000000000001';
  const second = '00000000-0000-4000-8000-000000000002';

  function panesAt(wide: boolean, search: string) {
    stubViewport(wide);

    return renderHook(() => usePanes(), {
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={[`/?${search}`]}>{children}</MemoryRouter>
      ),
    }).result.current;
  }

  it('draws every pane the address asks for when there is room', () => {
    const panes = panesAt(true, `item=${first}&item2=${second}`);

    expect(panes.panes).toHaveLength(2);
    expect(panes.canOpenBeside).toBe(true);
  });

  it('draws one pane, and refuses to offer another, when there is not', () => {
    // Below the breakpoint a second pane is not cramped, it is unreadable - and these arrangements
    // get pasted into messages, so a phone meets one on day one.
    const panes = panesAt(false, `item=${first}&item2=${second}`);

    expect(panes.panes).toHaveLength(1);
    expect(panes.canOpenBeside).toBe(false);
  });
});
