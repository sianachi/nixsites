import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UndoBar, UndoProvider } from '@nix/ui';
import { useState, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { draftFor, FALLBACK_RECIPE, type StudioDraft } from '../../../wizard/creation-studio-model';
import { BasicsStep } from '../../../wizard/creation-studio-steps';

function Step(): ReactNode {
  const [draft, setDraft] = useState<StudioDraft>(() => ({
    ...draftFor(FALLBACK_RECIPE),
    properties: ['A', 'B', 'C'].map((label) => ({
      key: label.toLowerCase(),
      label,
      type: 'text',
      options: [],
      required: false,
    })),
  }));
  return (
    <UndoProvider>
      <BasicsStep recipe={FALLBACK_RECIPE} draft={draft} onChange={setDraft} />
      <UndoBar />
    </UndoProvider>
  );
}

describe('undoing a field removal in the setup wizard', () => {
  it('puts a removed field back at its index', async () => {
    const user = userEvent.setup();
    render(<Step />);
    const names = (): string[] =>
      screen
        .getAllByRole('textbox', { name: 'Field name' })
        .map((el) => (el as HTMLInputElement).value);
    await user.click(screen.getByRole('button', { name: 'Remove B' }));
    expect(names()).toEqual(['A', 'C']);
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(names()).toEqual(['A', 'B', 'C']);
  });

  it('undoes a move and a required toggle one at a time, keeping the other change', async () => {
    const user = userEvent.setup();
    render(<Step />);
    const names = (): string[] =>
      screen
        .getAllByRole('textbox', { name: 'Field name' })
        .map((el) => (el as HTMLInputElement).value);
    await user.click(screen.getByRole('button', { name: 'Move A later' }));
    expect(names()).toEqual(['B', 'A', 'C']);
    const third = screen.getAllByRole('checkbox', { name: 'Required' })[2];
    if (third === undefined) throw new Error('Expected three Required boxes.');
    await user.click(third);
    expect(screen.getByText('Made “C” required')).toBeVisible();
    await user.click(screen.getByRole('button', { name: /^Undo/ }));
    expect(screen.getAllByRole('checkbox', { name: 'Required' })[2]).not.toBeChecked();
    expect(names()).toEqual(['B', 'A', 'C']);
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(names()).toEqual(['A', 'B', 'C']);
  });

  it('adds a field and undoes it', async () => {
    const user = userEvent.setup();
    render(<Step />);
    await user.click(screen.getByRole('button', { name: 'Add field' }));
    expect(screen.getAllByRole('textbox', { name: 'Field name' })).toHaveLength(4);
    expect(screen.getByText('Added field “Field 4”')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getAllByRole('textbox', { name: 'Field name' })).toHaveLength(3);
  });
});
