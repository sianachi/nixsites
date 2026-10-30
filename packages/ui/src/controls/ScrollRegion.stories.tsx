import { type Meta, type StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { ScrollRegion } from './ScrollRegion';

/** A labelled, keyboard-focusable scroll area; the caller supplies overflow and sizing. */
const meta = {
  title: 'Controls/ScrollRegion',
  component: ScrollRegion,
  args: {
    'aria-label': 'Wide table',
    className: 'max-w-xs overflow-x-auto',
    children: <div className="w-[48rem] py-2">Content wider than its region.</div>,
  },
} satisfies Meta<typeof ScrollRegion>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('region', { name: 'Wide table' })).toHaveAttribute(
      'tabindex',
      '0',
    );
  },
};
