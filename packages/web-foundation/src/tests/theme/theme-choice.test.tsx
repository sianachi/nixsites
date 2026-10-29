import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ThemeChoice } from '../../theme/theme-choice';
import { STORAGE_KEY } from '../../theme/theme-store';

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
  document.documentElement.removeAttribute('data-theme');
});

describe('the appearance control', () => {
  it('offers the machine and the two grounds', () => {
    render(<ThemeChoice />);

    expect(screen.getByRole('radio', { name: /system/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /light/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /dark/i })).toBeInTheDocument();
  });

  it('follows the machine until somebody says otherwise', () => {
    render(<ThemeChoice />);

    expect(screen.getByRole('radio', { name: /system/i })).toBeChecked();

    // No attribute at all, so the sheet's media query is what decides. Written as "light" here,
    // somebody on a dark machine would be pinned to light without ever having chosen it.
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('puts the chosen ground on the document', async () => {
    const user = userEvent.setup();
    render(<ThemeChoice />);

    await user.click(screen.getByRole('radio', { name: /dark/i }));

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('remembers the choice', async () => {
    const user = userEvent.setup();
    render(<ThemeChoice />);

    await user.click(screen.getByRole('radio', { name: /dark/i }));

    expect(stored.get(STORAGE_KEY) ?? null).toBe('dark');
  });

  it('goes back to following the machine, and stops naming a ground', async () => {
    const user = userEvent.setup();
    render(<ThemeChoice />);

    await user.click(screen.getByRole('radio', { name: /dark/i }));
    await user.click(screen.getByRole('radio', { name: /system/i }));

    // The attribute has to come off, not change to the resolved ground. Left set, the media query
    // would never apply again and the machine turning dark at dusk would move nothing.
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(stored.get(STORAGE_KEY) ?? null).toBeNull();
  });

  it('starts on the stored choice rather than on the machine', () => {
    stored.set(STORAGE_KEY, 'light');

    render(<ThemeChoice />);

    expect(screen.getByRole('radio', { name: /light/i })).toBeChecked();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('is one choice from a set rather than three separate buttons', () => {
    render(<ThemeChoice />);

    // A radio group announces the set, which member is current and its position, and moves between
    // members on the arrow keys. Three buttons would give none of that without being told to
    // imitate exactly this.
    const radios = screen.getAllByRole('radio');

    expect(radios).toHaveLength(3);
    expect(radios.filter((radio) => (radio as HTMLInputElement).checked)).toHaveLength(1);
  });

  it('is reachable and operable from the keyboard', async () => {
    const user = userEvent.setup();
    render(<ThemeChoice />);

    await user.tab();

    // The radio is off-screen rather than hidden, precisely so it keeps its place in the tab order
    // and in the accessibility tree - `display: none` would take both away.
    expect(screen.getByRole('radio', { name: /system/i })).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
