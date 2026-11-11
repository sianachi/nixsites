import { ThemeButton } from '@nix/web-foundation/theme/theme-choice';
import { within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';

export default { title: 'Nix/Shell/Appearance' };

export const ThemePicker = {
  render: (): ReactElement => <ThemeButton />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Theme' }));
    const picker = within(canvas.getByRole('dialog', { name: 'Theme' }));
    await userEvent.click(picker.getByRole('button', { name: 'Dark' }));
    await userEvent.selectOptions(picker.getByRole('combobox', { name: 'Palette' }), 'plum');
  },
};
