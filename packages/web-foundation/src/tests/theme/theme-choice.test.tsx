import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeButton } from '../../theme/theme-choice';
import { MODE_STORAGE_KEY, PALETTE_STORAGE_KEY } from '../../theme/theme-store';

/**
 * Choosing the ground, driven the way somebody uses it.
 *
 * What is asserted is the document attribute rather than any colour: every colour in the
 * application resolves through the token sheet's roles, so the attribute is the whole of what this
 * control does. A test that checked a computed colour would be testing Tailwind.
 */

/**
 * A working `localStorage`.
 *
 * jsdom's own is inert here - present, but with no methods - so the component would silently
 * behave as if storage were unavailable and every persistence assertion would pass vacuously.
 * Installing a real one is what makes "it remembers" a claim about the component rather than about
 * the environment.
 */
let stored: Map<string, string>;

beforeEach(() => {
  stored = new Map();

  Object.defineProperty(globalThis.window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value);
      },
      removeItem: (key: string) => {
        stored.delete(key);
      },
      clear: () => {
        stored.clear();
      },
      key: (index: number) => [...stored.keys()][index] ?? null,
      get length() {
        return stored.size;
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-palette');
  document.documentElement.removeAttribute('data-theme');
});

describe('the theme picker', () => {
  it('starts with the device appearance and saves an explicit mode and palette on apply', async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const user = userEvent.setup();
    const { unmount } = render(<ThemeButton />);
    await user.click(screen.getByRole('button', { name: 'Theme' }));

    const picker = within(screen.getByRole('dialog', { name: 'Theme' }));
    expect(picker.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-current', 'true');
    expect(picker.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Nix',
      'Graphite',
      'Pine',
      'Sand',
      'Rose',
      'Plum',
    ]);
    await user.selectOptions(picker.getByRole('combobox', { name: 'Palette' }), 'plum');

    const preview = picker.getByRole('region', { name: 'Theme preview' });
    const sample = within(preview).getByText('Launch brief').closest('[data-theme-preview]');
    expect(sample).toHaveAttribute('data-theme', 'dark');
    await user.click(picker.getByRole('button', { name: 'Light' }));
    expect(sample).toHaveAttribute('data-theme', 'light');
    expect(sample).toHaveAttribute('data-palette', 'plum');
    expect(document.documentElement).not.toHaveAttribute('data-theme');
    expect(document.documentElement).not.toHaveAttribute('data-palette');
    expect(stored.has(MODE_STORAGE_KEY)).toBe(false);
    expect(stored.has(PALETTE_STORAGE_KEY)).toBe(false);

    await user.click(picker.getByRole('button', { name: 'Apply theme' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(document.documentElement).toHaveAttribute('data-palette', 'plum');
    expect(screen.queryByRole('dialog', { name: 'Theme' })).not.toBeInTheDocument();

    unmount();
    render(<ThemeButton />);
    await user.click(screen.getByRole('button', { name: 'Theme' }));
    const reopened = within(screen.getByRole('dialog', { name: 'Theme' }));
    expect(reopened.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-current', 'true');
    expect(reopened.getByRole('combobox', { name: 'Palette' })).toHaveValue('plum');
  });

  it('discards previews on cancel and restores focus', async () => {
    const user = userEvent.setup();
    stored.set(MODE_STORAGE_KEY, 'dark');
    stored.set(PALETTE_STORAGE_KEY, 'pine');
    render(<ThemeButton />);

    const trigger = screen.getByRole('button', { name: 'Theme' });
    await user.click(trigger);
    let picker = within(screen.getByRole('dialog', { name: 'Theme' }));
    await user.click(picker.getByRole('button', { name: 'Light' }));
    await user.selectOptions(picker.getByRole('combobox', { name: 'Palette' }), 'rose');
    await user.click(picker.getByRole('button', { name: 'Cancel' }));

    expect(trigger).toHaveFocus();
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(document.documentElement).toHaveAttribute('data-palette', 'pine');

    await user.click(trigger);
    picker = within(screen.getByRole('dialog', { name: 'Theme' }));
    expect(picker.getByRole('combobox', { name: 'Palette' })).toHaveValue('pine');
  });
});
