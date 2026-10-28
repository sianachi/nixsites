import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderAt } from '../../render-with-router';
import { aContainer, views } from '../../container-fixture';
import { aView } from '../../view-fixture';
import { BoardView } from '../../../views/board/board-view';
import type { Item, PropertyDefinition } from '../../../views/core/container-model';
import { clearSuggestionDismissals } from '../../../lib/suggestion-dismissals';
import { useViewSuggestionPreference } from '../../../lib/suggestion-preferences';
import { anItem } from '../suggest/suggest-fixtures';
import { memoryStorage } from '../../memory-storage';

/**
 * The board's stale-card note: said only for a card far older than its column's usual, phrased as
 * "unchanged" because `updatedAt` is the only clock there is, and gone when waved away.
 */

const STATUS: PropertyDefinition = {
  key: 'status',
  label: 'Status',
  type: 'select',
  options: ['Doing', 'Done'],
  required: false,
};

const DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString();
}

function cards(ages: readonly number[]): Item[] {
  return ages.map((days, index) =>
    anItem(`Card ${String(index + 1)}`, { status: 'Doing' }, { updatedAt: daysAgo(days) }),
  );
}

const TAG: PropertyDefinition = {
  key: 'tag',
  label: 'Tag',
  type: 'select',
  options: ['a', 'b'],
  required: false,
};

function renderBoard(
  ages: readonly number[] | readonly Item[],
  options: { readonly url?: string; readonly truncated?: boolean } = {},
) {
  const children = typeof ages[0] === 'number' ? cards(ages as number[]) : (ages as Item[]);
  return renderAt(
    <BoardView
      container={aContainer({
        schema: { properties: [STATUS, TAG], declared: [STATUS, TAG], inherit: true },
        views: views([]),
        children,
        truncated: options.truncated ?? false,
      })}
      view={aView({ kind: 'board', groupBy: 'status' })}
      onOpen={vi.fn()}
    />,
    options.url,
  );
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  clearSuggestionDismissals();
  useViewSuggestionPreference.getState().setSetting('on');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the stale card note', () => {
  it('points out a card untouched far longer than its column usually is', () => {
    renderBoard([1, 1.5, 1.5, 2, 30]);

    const notes = screen.getAllByText(/No changes in/);
    expect(notes).toHaveLength(1);
    // The column median is a day and a half; it is rounded up, never down, so the sentence
    // does not claim the column moves faster than it does.
    expect(notes[0]).toHaveTextContent(
      'No changes in 30 days. Half the cards in Doing changed in the last 2 days.',
    );
  });

  it('stays quiet when the whole column moves at the same pace', () => {
    renderBoard([20, 21, 22, 25]);
    expect(screen.queryByText(/No changes in/)).not.toBeInTheDocument();
  });

  it('goes away when dismissed', () => {
    renderBoard([1, 2, 2, 3, 30]);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the stale card note on Card 5' }));
    expect(screen.queryByText(/No changes in/)).not.toBeInTheDocument();
  });

  it('stays dismissed when the board is opened again', () => {
    const children = cards([1, 2, 2, 3, 30]);
    const first = renderBoard(children);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the stale card note on Card 5' }));
    first.unmount();

    renderBoard(children);

    expect(screen.queryByText(/No changes in/)).not.toBeInTheDocument();
  });

  it('comes back once the card has changed and gone stale again', () => {
    const children = cards([1, 2, 2, 3, 30]);
    const first = renderBoard(children);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the stale card note on Card 5' }));
    first.unmount();

    const edited = children.map((item, index) =>
      index === 4 ? { ...item, updatedAt: daysAgo(29) } : item,
    );
    renderBoard(edited);

    expect(screen.getByText(/No changes in/)).toHaveTextContent('No changes in 29 days.');
  });

  it('judges a card against its whole column, not just the cards a filter leaves on screen', () => {
    // The column usually changes within two days. A filter leaves only three old cards showing:
    // judged among themselves they look ordinary (and are too few to judge at all), but against
    // the column they belong to every one of them is stale.
    const young = [1, 1, 2, 2].map((days, index) =>
      anItem(
        `Young ${String(index + 1)}`,
        { status: 'Doing', tag: 'b' },
        { updatedAt: daysAgo(days) },
      ),
    );
    const old = [20, 21, 30].map((days, index) =>
      anItem(
        `Old ${String(index + 1)}`,
        { status: 'Doing', tag: 'a' },
        { updatedAt: daysAgo(days) },
      ),
    );

    renderBoard([...young, ...old], { url: '/?f.tag=a' });

    expect(screen.getAllByText(/No changes in/)).toHaveLength(3);
    expect(screen.queryByText('Young 1')).not.toBeInTheDocument();
  });

  it('says nothing about ages when only part of the container is loaded', () => {
    // A truncated container's columns are a sample; a median over a sample is a guess.
    renderBoard([1, 1.5, 1.5, 2, 30], { truncated: true });
    expect(screen.queryByText(/No changes in/)).not.toBeInTheDocument();
  });

  it('is not shown when suggestions in views are switched off', () => {
    useViewSuggestionPreference.getState().setSetting('off');
    renderBoard([1, 2, 2, 3, 30]);
    expect(screen.queryByText(/No changes in/)).not.toBeInTheDocument();
  });
});
