import { fireEvent, waitFor, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';

import { CanvasBrowser } from './canvas-browser';
import type { CanvasElement } from './canvas-binding';

const elements: CanvasElement[] = [
  {
    id: 'plan',
    type: 'card',
    version: 1,
    versionNonce: 1,
    itemId: 'release-plan',
    title: 'Release plan',
  },
  {
    id: 'text',
    type: 'text',
    version: 1,
    versionNonce: 1,
    text: 'First line\nSecond line\nKeep the original canvas content readable on a phone.',
  },
  { id: 'drawing', type: 'rectangle', version: 1, versionNonce: 1 },
];

const meta = {
  title: 'Nix/Editor/Canvas contents',
  component: CanvasBrowser,
  args: {
    elements,
    onOpen: (): void => undefined,
    onSpatial: (): void => undefined,
    loading: false,
  },
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story: () => ReactNode): ReactNode => (
      <div className="h-dvh min-w-0 w-full bg-background">
        <Story />
      </div>
    ),
  ],
};

export default meta;

export const Contents = {};

export const LongContent = {
  args: {
    elements: [
      ...elements,
      {
        id: 'long-item',
        type: 'card',
        version: 1,
        versionNonce: 1,
        itemId: 'long-plan',
        title: 'A long item title that remains readable when the canvas opens on a small screen',
      },
      {
        id: 'long-text',
        type: 'text',
        version: 1,
        versionNonce: 1,
        text: 'AReallyLongUnbrokenWordThatShouldWrapInsideThePhoneCanvasRatherThanMakingTheWholePageScrollSideways',
      },
    ],
  },
};

export const SmallPhone = {
  args: LongContent.args,
  decorators: [
    (Story: () => ReactNode): ReactNode => (
      <div className="h-full w-70 max-w-full">
        <Story />
      </div>
    ),
  ],
  play: ({ canvasElement }: { canvasElement: HTMLElement }): void => {
    const canvas = within(canvasElement);
    const contents = canvas.getByRole('region', { name: 'Canvas contents' });
    if (contents.scrollWidth > contents.clientWidth) {
      throw new Error('Canvas content overflows the small phone width.');
    }
    canvas.getByRole('button', {
      name: 'A long item title that remains readable when the canvas opens on a small screen',
    });
  },
};

export const Empty = { args: { elements: [] } };
export const Loading = { args: { elements: [], loading: true } };
export const Dark = { globals: { ground: 'dark' } };

export const Search = {
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('searchbox', { name: 'Find in canvas' }), 'release');
    canvas.getByRole('button', { name: 'Release plan' });
    if (canvas.queryByText(/First line/)) throw new Error('Canvas search keeps unrelated text.');
  },
};

export const ContentActions = {
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    fireEvent.contextMenu(canvas.getByRole('button', { name: 'Release plan' }));
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(() => {
      const openItem = body.getByRole('menuitem', { name: 'Open item' });
      body.getByRole('menuitem', { name: 'Show spatial canvas' });
      if (canvasElement.ownerDocument.activeElement !== openItem) {
        throw new Error('The canvas content menu does not focus its first action.');
      }
    });
  },
};
