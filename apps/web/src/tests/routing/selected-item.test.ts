import { describe, expect, it, vi } from 'vitest';

import { clearViewState, parseSelectedItem } from '../../panes/pane-params';
import { selectedItemSearch } from '../../routing/selected-item';

describe('the selected item parameter', () => {
  it('reads an identifier out of the URL', () => {
    expect(parseSelectedItem('1e1e1e1e-1111-4111-8111-1e1e1e1e1e1e')).toBe(
      '1e1e1e1e-1111-4111-8111-1e1e1e1e1e1e',
    );
  });

  it('treats an absent parameter as nothing open', () => {
    expect(parseSelectedItem(null)).toBeNull();
    expect(parseSelectedItem('')).toBeNull();
  });

  it('drops a value that is not an identifier, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // The URL is the most hostile runtime boundary there is - anybody can type into it - so a
    // malformed one leaves the shell with nothing open rather than sending nonsense to Core.
    expect(parseSelectedItem('../../etc/passwd')).toBeNull();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it('builds a shareable search string', () => {
    expect(selectedItemSearch('1e1e1e1e-1111-4111-8111-1e1e1e1e1e1e')).toBe(
      '?item=1e1e1e1e-1111-4111-8111-1e1e1e1e1e1e',
    );
  });
});

describe('moving to another item', () => {
  it('leaves the previous item view state behind', () => {
    // Every item can carry views now, so two siblings can easily both have one called `by-status`.
    // Carried across, the second would open on a board nobody asked for; and where the id does not
    // match, the choice would look ignored instead.
    const params = new URLSearchParams(
      'item=11111111-1111-4111-8111-111111111111&view=by-status&sort=owner&dir=descending&f.status=Doing',
    );

    clearViewState(params);

    expect(params.get('view')).toBeNull();
    expect(params.get('sort')).toBeNull();
    expect(params.get('dir')).toBeNull();
    expect(params.get('f.status')).toBeNull();

    // The item itself is not view state and has to survive.
    expect(params.get('item')).toBe('11111111-1111-4111-8111-111111111111');
  });
});
