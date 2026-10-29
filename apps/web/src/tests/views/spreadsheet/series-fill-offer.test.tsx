import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderAt } from '@nix/web-editor/testing/render-with-router';
import { aContainer } from '../../container-fixture';
import { aView } from '../../view-fixture';
import type { PlanWrite } from '../../../views/core/use-container';
import { SpreadsheetView } from '../../../views/spreadsheet/spreadsheet-view';
import { anItem } from '../suggest/suggest-fixtures';
import { useViewSuggestionPreference } from '@nix/web-foundation/lib/suggestion-preferences';

/**
 * The spreadsheet's offer to continue a series down a selection: shown for a real pattern, applied
 * through the grid's one bulk write, and never applied without being asked.
 */

const SCHEMA = {
  properties: [{ key: 'week', label: 'Week', type: 'text', options: [], required: false }],
  declared: [],
  inherit: true,
};

beforeEach(() => {
  useViewSuggestionPreference.getState().setSetting('on');
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});

function renderSheet(
  fourth: Record<string, string> = {},
  setPropertiesMany = vi.fn((writes: readonly PlanWrite[]) =>
    Promise.resolve({ saved: writes.length, refused: [] }),
  ),
) {
  const items = [
    anItem('One', { week: 'Week 1' }),
    anItem('Two', { week: 'Week 2' }),
    anItem('Three'),
    anItem('Four', fourth),
  ];
  renderAt(
    <SpreadsheetView
      container={aContainer({ schema: SCHEMA, children: items, setPropertiesMany })}
      view={aView({ kind: 'spreadsheet', columns: ['week'] })}
      onOpen={vi.fn()}
    />,
  );
  return { items, setPropertiesMany };
}

function selectWeekRows(): void {
  fireEvent.mouseDown(screen.getByRole('gridcell', { name: 'Week for One, Week 1' }));
  fireEvent.mouseDown(screen.getByRole('gridcell', { name: /^Week for Four/ }), { shiftKey: true });
}

describe('the series fill offer', () => {
  it('offers to continue the pattern it sees, naming the values first', () => {
    renderSheet();
    expect(screen.queryByText(/continues as a series/)).not.toBeInTheDocument();

    selectWeekRows();

    expect(screen.getByText(/continues as a series/)).toHaveTextContent(
      'Week continues as a series (+1): Week 3, Week 4. Ctrl+Shift+D does the same.',
    );
  });

  it('does not offer to overwrite a filled cell, but the shortcut still fills on request', async () => {
    const { items, setPropertiesMany } = renderSheet({ week: 'Kept' });
    selectWeekRows();

    expect(screen.queryByText(/continues as a series/)).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('grid'), { key: 'D', ctrlKey: true, shiftKey: true });

    await waitFor(() => {
      expect(setPropertiesMany).toHaveBeenCalledTimes(1);
    });
    expect(setPropertiesMany.mock.calls[0]?.[0]).toEqual([
      { itemId: items[2]?.id, label: 'Three', properties: { week: 'Week 3' } },
      { itemId: items[3]?.id, label: 'Four', properties: { week: 'Week 4' } },
    ]);
  });

  it('is not offered when suggestions in views are switched off', () => {
    useViewSuggestionPreference.getState().setSetting('off');
    renderSheet();
    selectWeekRows();

    expect(screen.queryByText(/continues as a series/)).not.toBeInTheDocument();
  });

  it('writes the continuation through the bulk write when accepted', async () => {
    const { items, setPropertiesMany } = renderSheet();
    selectWeekRows();

    fireEvent.click(screen.getByRole('button', { name: 'Fill 2 rows with the series in Week' }));

    await waitFor(() => {
      expect(setPropertiesMany).toHaveBeenCalledTimes(1);
    });
    expect(setPropertiesMany.mock.calls[0]?.[0]).toEqual([
      { itemId: items[2]?.id, label: 'Three', properties: { week: 'Week 3' } },
      { itemId: items[3]?.id, label: 'Four', properties: { week: 'Week 4' } },
    ]);
  });

  it('applies the same fill from the keyboard', async () => {
    const { setPropertiesMany } = renderSheet();
    selectWeekRows();

    fireEvent.keyDown(screen.getByRole('grid'), { key: 'D', ctrlKey: true, shiftKey: true });

    await waitFor(() => {
      expect(setPropertiesMany).toHaveBeenCalledTimes(1);
    });
  });

  it('goes away when dismissed, without writing', () => {
    const { setPropertiesMany } = renderSheet();
    selectWeekRows();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the series suggestion' }));

    expect(screen.queryByText(/continues as a series/)).not.toBeInTheDocument();
    expect(setPropertiesMany).not.toHaveBeenCalled();
  });
});
