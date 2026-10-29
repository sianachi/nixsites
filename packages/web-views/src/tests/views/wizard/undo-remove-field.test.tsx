import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  return <BasicsStep recipe={FALLBACK_RECIPE} draft={draft} onChange={setDraft} />;
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
});
