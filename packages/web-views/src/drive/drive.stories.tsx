import type { ReactNode } from 'react';
import { within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';

import {
  recordStoryView,
  storyContainer,
  storyItem,
} from '@nix/web-collections/core/story-container';
import { ContainerView } from '../core/container-view';
import { RecordViewStory, STORY_FILE } from '../list/record-view-story';
import { DriveMoveDialog } from './drive-move-dialog';

export default { title: 'Nix/Views/Drive', parameters: { layout: 'padded' } };
function Example({
  layout = 'list',
  longNames = false,
}: {
  readonly layout?: string;
  readonly longNames?: boolean;
}): ReactNode {
  return (
    <RecordViewStory>
      <ContainerView
        container={storyContainer(
          [
            storyItem('a', longNames ? 'WeekendPlan'.repeat(12) : 'Ideas for a quiet weekend', 1),
            storyItem('b', 'Canvas for the garden plan', 2, {}, 'canvas'),
            storyItem(
              STORY_FILE,
              longNames ? `${'ReadingList'.repeat(12)}.txt` : 'Reading list.txt',
              3,
              {},
              'file',
            ),
          ],
          [],
          { itemId: null },
        )}
        view={recordStoryView('drive', { layout })}
        onOpen={() => undefined}
      />
    </RecordViewStory>
  );
}
export const Files = { render: (): ReactNode => <Example /> };
export const Grid = { render: (): ReactNode => <Example layout="grid" /> };
export const NarrowFiles = {
  render: (): ReactNode => (
    <div className="max-w-xs">
      <Example />
    </div>
  ),
};
export const NarrowLongFiles = {
  render: (): ReactNode => (
    <div className="max-w-xs">
      <Example longNames />
    </div>
  ),
};
export const NarrowLongGrid = {
  render: (): ReactNode => (
    <div className="max-w-xs">
      <Example layout="grid" longNames />
    </div>
  ),
};
export const LongMoveDestination = {
  render: (): ReactNode => (
    <DriveMoveDialog
      open
      onClose={() => undefined}
      selectedCount={3}
      destinations={[{ id: 'destination', title: 'ProjectArchive'.repeat(12) }]}
      parent={undefined}
      onMove={() => undefined}
    />
  ),
};
/** Exercises the shared selection tray so the browser story's axe pass sees its controls. */
export const Selection = {
  ...Files,
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Select Reading list.txt' }));
    canvas.getByRole('toolbar', { name: 'Selected items' });
    canvas.getByRole('button', { name: 'Download' });
  },
};
export const RowActions = {
  ...Grid,
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    within(canvasElement).getByRole('button', { name: 'Reading list.txt' }).focus();
    await userEvent.keyboard('{Shift>}{F10}{/Shift}');
  },
};
export const DarkFiles = { ...Files, globals: { ground: 'dark' } };
export const DarkGrid = { ...Grid, globals: { ground: 'dark' } };
export const DarkNarrowFiles = { ...NarrowFiles, globals: { ground: 'dark' } };
export const DarkSelection = { ...Selection, globals: { ground: 'dark' } };
export const DarkRowActions = { ...RowActions, globals: { ground: 'dark' } };
