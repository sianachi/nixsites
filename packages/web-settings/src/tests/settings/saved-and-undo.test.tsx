import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { UndoBar, UndoProvider } from '@nix/ui';
import { PreferenceToggle } from '../../settings/shared/preference-toggle';
import { revertChanged } from '../../settings/shared/unsaved';

function Harness(props: { readonly draft?: boolean }): ReactElement {
  const [on, setOn] = useState(false);
  return (
    <UndoProvider>
      <PreferenceToggle
        label="Show status bar"
        checked={on}
        onChange={setOn}
        description="d"
        unsaved={null}
        {...(props.draft === undefined ? {} : { draft: props.draft })}
      />
      <UndoBar />
    </UndoProvider>
  );
}

describe('a saved-as-you-flip switch', () => {
  it('confirms beside the switch and undoes only its own flip', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('checkbox', { name: 'Show status bar' }));
    expect(screen.getByText('✓ Saved').closest('[data-saved-mark]')).toHaveAttribute(
      'data-saved-mark',
      'on',
    );
    expect(screen.getByText('Turned on “Show status bar”')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByRole('checkbox', { name: 'Show status bar' })).not.toBeChecked();
  });

  it('says nothing and records nothing for a change that waits for Save', async () => {
    const user = userEvent.setup();
    render(<Harness draft />);

    await user.click(screen.getByRole('checkbox', { name: 'Show status bar' }));
    expect(screen.queryByText('✓ Saved')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });
});

describe('reverting a save', () => {
  it('sets back only the fields the save changed, keeping later edits', () => {
    const before = { folders: 'by-month', title: 'iso' };
    const saved = { folders: 'by-month', title: 'long' };
    const current = { folders: 'flat', title: 'long' };
    expect(revertChanged(before, saved, current)).toEqual({ folders: 'flat', title: 'iso' });
  });
});
