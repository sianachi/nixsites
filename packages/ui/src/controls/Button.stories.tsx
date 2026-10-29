import { type Meta, type StoryObj } from '@storybook/react-vite';
import { ArrowRight, Plus, Search, Trash2 } from 'lucide-react';
import { expect, fn, userEvent, within } from 'storybook/test';

import { Icon } from '../primitives/Icon';
import { Text } from '../primitives/Text';
import { Button } from './Button';

/**
 * Every variant and every interaction state of the action control.
 *
 * Hover, pressed and focus are exercised with real input in `play` functions
 * rather than faked with a class, so what the story shows is what a user gets;
 * axe runs over each of them.
 */
const meta = {
  title: 'Controls/Button',
  component: Button,
  args: {
    children: 'Publish document',
  },
  argTypes: {
    variant: {
      control: 'inline-radio',
      options: ['primary', 'secondary', 'ghost', 'subtle', 'icon'],
    },
    fullWidth: { control: 'boolean' },
    disabled: { control: 'boolean' },
  },
} satisfies Meta<typeof Button>;

export default meta;

type Story = StoryObj<typeof meta>;

// ── Variants ──────────────────────────────────────────────────────────────

/** The one solid accent object on the board. */
export const Primary: Story = {
  args: { variant: 'primary' },
};

/** A hairline outlined box: the ordinary action. */
export const Secondary: Story = {
  args: { variant: 'secondary', children: 'Discard changes' },
};

/** Type only, for a tertiary action that must not compete. */
export const Ghost: Story = {
  args: { variant: 'ghost', children: 'Cancel' },
};

/** Muted type or glyph, for chrome that recedes beside content: a row's actions, a close. */
export const Subtle: Story = {
  args: { variant: 'subtle', children: 'Close' },
};

/** A square outlined box holding one glyph; the label lives in aria-label. */
export const IconOnly: Story = {
  args: {
    variant: 'icon',
    'aria-label': 'Add block',
    children: <Icon icon={Plus} />,
  },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Add block' });
    const touch = matchMedia('(any-pointer: coarse)').matches;
    const size = getComputedStyle(document.documentElement)
      .getPropertyValue(touch ? '--control-lg' : '--control-md')
      .trim();
    await expect(getComputedStyle(button).height).toBe(size);
    await expect(getComputedStyle(button).width).toBe(size);
  },
};

/** The block button: stretched to its container. */
export const FullWidth: Story = {
  args: { variant: 'primary', fullWidth: true },
  parameters: { layout: 'padded' },
};

/** A glyph beside a label. The icon is decorative, so it stays unnamed. */
export const WithLeadingIcon: Story = {
  args: {
    variant: 'secondary',
    children: (
      <>
        <Icon icon={Search} size="sm" />
        Find in document
      </>
    ),
  },
};

/** The same, reading forward. */
export const WithTrailingIcon: Story = {
  args: {
    variant: 'primary',
    children: (
      <>
        Continue
        <Icon icon={ArrowRight} size="sm" />
      </>
    ),
  },
};

// ── Interaction states ────────────────────────────────────────────────────

/** Hover: one step deeper into the accent ramp on the fill. */
export const PrimaryHover: Story = {
  args: { variant: 'primary' },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Publish document' });
    await userEvent.hover(button);
  },
};

/** Pressed: the pointer is held down, so `:active` is live. */
export const PrimaryPressed: Story = {
  args: { variant: 'primary' },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Publish document' });
    await userEvent.pointer([{ target: button, keys: '[MouseLeft>]' }]);
  },
};

/** Keyboard focus: the 2px accent outline, offset by 2px. Never the default. */
export const PrimaryFocusVisible: Story = {
  args: { variant: 'primary' },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Publish document' });
    await userEvent.tab();
    await expect(button).toHaveFocus();
  },
};

/** Disabled: 45% opacity, out of the tab order, deaf to clicks. */
export const PrimaryDisabled: Story = {
  args: { variant: 'primary', disabled: true },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Publish document' });
    await expect(button).toBeDisabled();
    await userEvent.tab();
    await expect(button).not.toHaveFocus();
  },
};

/** Secondary hover: an ink wash rather than an accent one. */
export const SecondaryHover: Story = {
  args: { variant: 'secondary', children: 'Discard changes' },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Discard changes' });
    await userEvent.hover(button);
  },
};

export const SecondaryPressed: Story = {
  args: { variant: 'secondary', children: 'Discard changes' },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Discard changes' });
    await userEvent.pointer([{ target: button, keys: '[MouseLeft>]' }]);
  },
};

export const SecondaryFocusVisible: Story = {
  args: { variant: 'secondary', children: 'Discard changes' },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Discard changes' });
    await userEvent.tab();
    await expect(button).toHaveFocus();
  },
};

export const SecondaryDisabled: Story = {
  args: { variant: 'secondary', children: 'Discard changes', disabled: true },
};

/** Ghost hover: a translucent accent wash, the ground reading through. */
export const GhostHover: Story = {
  args: { variant: 'ghost', children: 'Cancel' },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Cancel' });
    await userEvent.hover(button);
  },
};

export const SubtleHover: Story = {
  args: { variant: 'subtle', children: 'Close' },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Close' });
    await userEvent.hover(button);
  },
};

export const GhostPressed: Story = {
  args: { variant: 'ghost', children: 'Cancel' },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Cancel' });
    await userEvent.pointer([{ target: button, keys: '[MouseLeft>]' }]);
  },
};

export const GhostFocusVisible: Story = {
  args: { variant: 'ghost', children: 'Cancel' },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Cancel' });
    await userEvent.tab();
    await expect(button).toHaveFocus();
  },
};

export const GhostDisabled: Story = {
  args: { variant: 'ghost', children: 'Cancel', disabled: true },
};

export const IconHover: Story = {
  args: {
    variant: 'icon',
    'aria-label': 'Delete block',
    children: <Icon icon={Trash2} />,
  },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Delete block' });
    await userEvent.hover(button);
  },
};

export const IconPressed: Story = {
  args: {
    variant: 'icon',
    'aria-label': 'Delete block',
    children: <Icon icon={Trash2} />,
  },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Delete block' });
    await userEvent.pointer([{ target: button, keys: '[MouseLeft>]' }]);
  },
};

export const IconFocusVisible: Story = {
  args: {
    variant: 'icon',
    'aria-label': 'Delete block',
    children: <Icon icon={Trash2} />,
  },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Delete block' });
    await userEvent.tab();
    await expect(button).toHaveFocus();
  },
};

export const IconDisabled: Story = {
  args: {
    variant: 'icon',
    'aria-label': 'Delete block',
    disabled: true,
    children: <Icon icon={Trash2} />,
  },
};

// ── Keyboard contract ─────────────────────────────────────────────────────

/** Enter and Space both activate; the count proves neither was swallowed. */
export const KeyboardActivation: Story = {
  args: { variant: 'primary', children: 'Publish document', onClick: fn() },
  play: async ({ canvasElement, args }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Publish document' });

    await userEvent.tab();
    await expect(button).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');

    await expect(args.onClick).toHaveBeenCalledTimes(2);
  },
};

/** A disabled button stays silent under the same keyboard input. */
export const DisabledIgnoresInput: Story = {
  args: { variant: 'primary', children: 'Publish document', disabled: true, onClick: fn() },
  play: async ({ canvasElement, args }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Publish document' });

    await userEvent.click(button);
    await userEvent.keyboard('{Enter}');

    await expect(args.onClick).not.toHaveBeenCalled();
  },
};

// ── The set, side by side ─────────────────────────────────────────────────

/** All four variants together: only one of them is filled. */
export const AllVariants: Story = {
  args: { children: 'Publish document' },
  parameters: { layout: 'padded' },
  render: () => (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-4">
        <Button variant="primary">Publish document</Button>
        <Button variant="secondary">Discard changes</Button>
        <Button variant="ghost">Cancel</Button>
        <Button variant="icon" aria-label="Add block">
          <Icon icon={Plus} />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Button variant="primary" disabled>
          Publish document
        </Button>
        <Button variant="secondary" disabled>
          Discard changes
        </Button>
        <Button variant="ghost" disabled>
          Cancel
        </Button>
        <Button variant="icon" aria-label="Add block" disabled>
          <Icon icon={Plus} />
        </Button>
      </div>
      <Text variant="caption" tone="muted">
        Top row: resting. Bottom row: disabled at 45% opacity.
      </Text>
    </div>
  ),
};

/**
 * The same four on ink. Nothing here carries a `dark:` variant: the fill and
 * the ghost's type are `--color-accent-text`, the label on the fill is
 * `--color-background`, and the two swap ends of the accent ramp together - so
 * the one solid object keeps its 4.5:1 by construction rather than by a second
 * set of classes kept in step by hand.
 *
 * Hover and pressed are deliberately absent from this story. Their ramp steps
 * are still tuned to the light ground and read about 1.8:1 under a dark label;
 * see `interaction.ts` for why that cannot be fixed without a fill role in the
 * token sheet. Adding a dark hover story here would assert a state the library
 * does not yet get right.
 */
export const AllVariantsDark: Story = {
  args: { children: 'Publish document' },
  globals: { ground: 'dark' },
  parameters: { layout: 'padded' },
  render: () => (
    <div className="flex flex-wrap items-center gap-4">
      <Button variant="primary">Publish document</Button>
      <Button variant="secondary">Discard changes</Button>
      <Button variant="ghost">Cancel</Button>
      <Button variant="icon" aria-label="Add block">
        <Icon icon={Plus} />
      </Button>
    </div>
  ),
};
