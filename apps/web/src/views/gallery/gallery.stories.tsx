import type { ReactNode } from 'react';
import { waitFor, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';

import { PaneViewport } from '@nix/web-foundation/layout/pane-viewport';
import { storyContainer, storyItem } from '../core/story-container';
import { RecordViewStory, recordStoryView } from '../list/record-view-story';
import { GalleryView } from './gallery-view';

export default { title: 'Nix/Views/Gallery', parameters: { layout: 'padded' } };
function Example(): ReactNode {
  return (
    <RecordViewStory>
      <GalleryView
        container={storyContainer(
          [storyItem('a', 'Notes for a poem', 1), storyItem('b', 'Plans for next year', 2)],
          [],
        )}
        view={recordStoryView('gallery', { cardSize: 'small' })}
        onOpen={() => undefined}
      />
    </RecordViewStory>
  );
}
export const Plans = { render: (): ReactNode => <Example /> };
export const NarrowPlans = {
  render: (): ReactNode => (
    <div className="max-w-xs">
      <Example />
    </div>
  ),
};
export const LongLabels = {
  render: (): ReactNode => (
    <RecordViewStory>
      <GalleryView
        container={storyContainer(
          [
            storyItem('long', 'NotesForTheEditorialReviewAndPublicationDecision', 1, {
              owner: 'PublishingTeamResponsibleForTheEditorialReview',
            }),
          ],
          [
            {
              key: 'owner',
              label: 'PublishingTeamResponsibleForTheEditorialReview',
              type: 'text',
              options: [],
              required: false,
            },
          ],
        )}
        view={recordStoryView('gallery', { columns: ['owner'] })}
        onOpen={() => undefined}
      />
    </RecordViewStory>
  ),
};
export const CoverPicker = {
  ...Plans,
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    await userEvent.click(
      within(canvasElement).getByRole('button', { name: 'Set cover for Notes for a poem' }),
    );
  },
};
export const DarkPlans = { ...Plans, globals: { ground: 'dark' } };
export const DarkNarrowPlans = { ...NarrowPlans, globals: { ground: 'dark' } };
export const DarkCoverPicker = { ...CoverPicker, globals: { ground: 'dark' } };

function ManyCards(): ReactNode {
  const items = Array.from({ length: 200 }, (_unused, index) =>
    storyItem(`virtual-${String(index)}`, `Item ${String(index + 1)}`, index, {
      owner: 'Saved owner',
    }),
  );
  return (
    <RecordViewStory>
      <PaneViewport className="h-96 w-full max-w-5xl overflow-auto">
        <GalleryView
          container={storyContainer(items, [
            { key: 'owner', label: 'Owner', type: 'text', options: [], required: false },
          ])}
          view={recordStoryView('gallery', { cardSize: 'small', columns: ['owner'] })}
          onOpen={() => undefined}
        />
      </PaneViewport>
    </RecordViewStory>
  );
}

export const VirtualizedDraft = {
  render: (): ReactNode => <ManyCards />,
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    const pane = canvasElement.querySelector<HTMLElement>('[data-pane-viewport]');
    if (pane === null) throw new Error('The gallery needs its pane scroller');
    const root = within(canvasElement).getByRole('list', { name: 'Plans' });
    const grid = root.querySelector('ul');
    if (grid === null) throw new Error('The gallery needs its stable card grid');
    const card = (title: string): HTMLElement => {
      const element = within(root).getByRole('button', { name: title }).closest('li');
      if (element === null) throw new Error(`${title} needs its card`);
      return element;
    };
    await userEvent.click(within(card('Item 2')).getByRole('button', { name: /Owner for Item 2/ }));
    const field = within(card('Item 2')).getByRole<HTMLInputElement>('textbox', {
      name: 'Owner for Item 2',
    });
    await userEvent.clear(field);
    await userEvent.type(field, 'Draft owner');
    const checkEnd = async (): Promise<void> => {
      pane.scrollTop = pane.scrollHeight;
      await waitFor(() => {
        const gap = Number.parseFloat(getComputedStyle(grid).rowGap);
        const bottomGap =
          root.getBoundingClientRect().bottom - card('Item 200').getBoundingClientRect().bottom;
        if (!Number.isFinite(gap) || Math.abs(bottomGap - gap) > 1)
          throw new Error(
            `Virtual bottom gap ${String(bottomGap)} differs from CSS row gap ${String(gap)}`,
          );
        if (document.activeElement !== field || field.value !== 'Draft owner')
          throw new Error('A retained card lost its focused draft');
        if (within(root).getAllByRole('listitem').length >= 100)
          throw new Error('The disjoint focused card expanded the virtual window');
      });
    };
    await checkEnd();
    pane.style.width = '320px';
    await waitFor(() => {
      if (card('Item 2').dataset.virtualIndex !== '1')
        throw new Error('The narrow pane must reflow to one column');
    });
    await checkEnd();
    pane.style.width = '';
    await waitFor(() => {
      if (card('Item 2').dataset.virtualIndex !== '0')
        throw new Error('The wider pane must reflow to several columns');
    });
    await checkEnd();
  },
};
export const DarkVirtualizedDraft = { ...VirtualizedDraft, globals: { ground: 'dark' } };
