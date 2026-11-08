import { type Meta, type StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';

import { Button } from './Button';
import { Toast } from './Toast';
import { UndoBar, UndoProvider, useUndo } from './undo';

/**
 * A transient notice with room for one way to undo it - built for the workspace tree's delete
 * flow, general enough to serve a second caller without a rewrite. See `Toast.tsx`'s own comment
 * for the reasoning behind `role="status"`, the focus handling, and the pause-on-hover timeout.
 */
const meta = {
  title: 'Controls/Toast',
  component: Toast,
  args: {
    message: 'Deleted "Q3 roadmap".',
    onDismiss: fn(),
  },
  parameters: {
    // A fixed position at the story's own scale would just clip inside the canvas frame; the
    // component itself carries no position, so these stories render it in flow instead - see
    // `app-shell.tsx` for how the real caller places it in the viewport.
    layout: 'padded',
  },
} satisfies Meta<typeof Toast>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The usual shape: what happened, an Undo, and a way to dismiss without acting. */
export const WithAction: Story = {
  args: {
    action: { label: 'Undo', onAction: fn() },
  },
};

/** A notice with nothing to undo - the dismiss control is still the only way out. */
export const WithoutAction: Story = {};

/** Several items at once, in the exact wording pattern the sidebar's own warning used to use. */
export const WithDescendants: Story = {
  args: {
    message: 'Deleted "Engineering" and the 4 items inside it.',
    action: { label: 'Undo', onAction: fn() },
  },
};

export const DarkGround: Story = {
  globals: { ground: 'dark' },
  args: {
    action: { label: 'Undo', onAction: fn() },
  },
};

/** Pressing Undo runs the action and closes the toast in the same gesture. */
export const PressingUndo: Story = {
  args: {
    action: { label: 'Undo', onAction: fn() },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);

    await userEvent.click(canvas.getByRole('button', { name: 'Undo' }));

    await expect(args.action?.onAction).toHaveBeenCalledTimes(1);
    await expect(args.onDismiss).toHaveBeenCalledTimes(1);
  },
};

/**
 * Phone: the shell shows at most one toast, collapsing several reminders into this summary. A
 * persistent toast never times out, so it waits until the reader opens or dismisses it.
 */
export const PhoneReminders: Story = {
  args: {
    message: '3 reminders',
    action: { label: 'View', onAction: fn() },
    persistent: true,
    autoFocus: false,
  },
  render: (args) => (
    <div className="w-[24rem] max-w-full">
      <Toast {...args} />
    </div>
  ),
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByRole('status')).toHaveTextContent('3 reminders');
    await userEvent.click(canvas.getByRole('button', { name: 'View' }));
    await expect(args.action?.onAction).toHaveBeenCalledTimes(1);
    await expect(args.onDismiss).toHaveBeenCalledTimes(1);
  },
};

/** Focus lands on Undo as soon as the toast appears, since the row that triggered it is gone. */
export const FocusesItsAction: Story = {
  args: {
    action: { label: 'Undo', onAction: fn() },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByRole('button', { name: 'Undo' })).toHaveFocus();
  },
};

/**
 * The round trip a delete actually produces: a row disappears, the toast appears with Undo
 * already focused, and dismissing it - by any path - returns focus to a durable landing spot
 * rather than the body.
 */
function DeleteHarness(): ReactNode {
  const [deleted, setDeleted] = useState(false);
  const [showToast, setShowToast] = useState(false);

  return (
    <div className="flex flex-col gap-3 p-8">
      {deleted ? null : (
        <Button
          variant="secondary"
          onClick={() => {
            setDeleted(true);
            setShowToast(true);
          }}
        >
          Delete "Q3 roadmap"
        </Button>
      )}

      <p className="text-sm text-muted">{deleted ? 'Nothing here now.' : 'One item.'}</p>

      {showToast ? (
        <Toast
          message='Deleted "Q3 roadmap".'
          action={{
            label: 'Undo',
            onAction: () => {
              setDeleted(false);
            },
          }}
          onDismiss={() => {
            setShowToast(false);
          }}
        />
      ) : null}
    </div>
  );
}

export const DeleteAndUndo: Story = {
  render: () => <DeleteHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(canvas.getByRole('button', { name: 'Delete "Q3 roadmap"' }));
    await expect(canvas.getByRole('status')).toHaveTextContent('Deleted "Q3 roadmap".');

    await userEvent.click(canvas.getByRole('button', { name: 'Undo' }));
    await expect(canvas.getByRole('button', { name: 'Delete "Q3 roadmap"' })).toBeInTheDocument();
    await expect(canvas.queryByRole('status')).toBeNull();
  },
};

/** The shared undo history: two actions, Cmd/Ctrl+Z or the button reverses the newest first. */
function UndoHarness(): ReactNode {
  const undo = useUndo();
  return (
    <div className="flex flex-col gap-3 p-8">
      <Button
        variant="secondary"
        onClick={() => {
          undo.push('Removed "Q3 roadmap"', () => undefined);
        }}
      >
        Remove "Q3 roadmap"
      </Button>
      <UndoBar />
    </div>
  );
}

export const UndoHistory: Story = {
  render: () => (
    <UndoProvider>
      <UndoHarness />
    </UndoProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(canvas.getByRole('button', { name: 'Remove "Q3 roadmap"' }));
    await expect(canvas.getByRole('status')).toHaveTextContent('Removed "Q3 roadmap"');
    await userEvent.click(canvas.getByRole('button', { name: 'Undo' }));
    await expect(canvas.queryByRole('button', { name: 'Undo' })).toBeNull();
  },
};
