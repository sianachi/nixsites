import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { LineListInput } from '../../../core/line-list-input';

function Editor() {
  const [value, setValue] = useState<string[]>([]);
  return (
    <>
      <LineListInput aria-label="Options" value={[...value]} onChange={setValue} />
      <output aria-label="Saved options">{JSON.stringify(value)}</output>
      <button
        onClick={() => {
          setValue(['Replacement']);
        }}
      >
        Replace options
      </button>
    </>
  );
}

describe('editing a list of lines', () => {
  it('preserves Enter, blank lines, spaces, paste and deletion while publishing clean options', async () => {
    const user = userEvent.setup();
    render(<Editor />);
    const input = screen.getByRole('textbox', { name: 'Options' });
    await user.type(input, 'In progress{Enter}{Enter}Ready for review ');
    expect(input).toHaveValue('In progress\n\nReady for review ');
    expect(input).toHaveFocus();
    expect(screen.getByLabelText('Saved options')).toHaveTextContent(
      '["In progress","Ready for review"]',
    );
    await user.paste('\nDone\n');
    expect(input).toHaveValue('In progress\n\nReady for review \nDone\n');
    await user.keyboard('{Backspace}{Backspace}');
    expect(input).toHaveValue('In progress\n\nReady for review \nDon');
    await user.clear(input);
    expect(input).toHaveValue('');
    expect(screen.getByLabelText('Saved options')).toHaveTextContent('[]');
  });

  it('accepts an external replacement after an unfinished line', async () => {
    const user = userEvent.setup();
    render(<Editor />);
    await user.type(screen.getByRole('textbox'), 'Old{Enter}');
    await user.click(screen.getByRole('button', { name: 'Replace options' }));
    expect(screen.getByRole('textbox')).toHaveValue('Replacement');
  });
});
