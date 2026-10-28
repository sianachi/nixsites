import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { TextWidthControl } from '@nix/web-editor/editor/text-width-control';
import {
  loadTextWidth,
  TEXT_WIDTH_STORAGE_KEY,
  useTextWidthPreference,
} from '@nix/web-editor/editor/text-width-preference';
import { memoryStorage } from '../memory-storage';

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  useTextWidthPreference.setState({ width: 'reading', saved: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem(TEXT_WIDTH_STORAGE_KEY);
  useTextWidthPreference.setState({ width: 'reading', saved: true });
  vi.unstubAllGlobals();
});

it('remembers full pane width and restores the writing-mode width on request', async () => {
  render(<TextWidthControl />);
  await userEvent.click(screen.getByRole('button', { name: 'Text width' }));
  await userEvent.click(screen.getByRole('button', { name: 'Full pane width' }));
  expect(loadTextWidth(localStorage)).toEqual({ width: 'full', saved: true });
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Text width' })).toHaveFocus();
  });
  await userEvent.click(screen.getByRole('button', { name: 'Text width' }));
  expect(screen.getByRole('button', { name: 'Full pane width' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Reading width' }));
  expect(loadTextWidth(localStorage)).toEqual({ width: 'reading', saved: true });
  expect(localStorage.getItem(TEXT_WIDTH_STORAGE_KEY)).toBeNull();
});

it('falls back to reading width for unknown preferences and works with blocked storage', async () => {
  localStorage.setItem(TEXT_WIDTH_STORAGE_KEY, 'unbounded');
  expect(loadTextWidth(localStorage)).toEqual({ width: 'reading', saved: true });
  expect(loadTextWidth(undefined)).toEqual({ width: 'reading', saved: false });
  vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
    throw new Error('Storage unavailable');
  });
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('Storage unavailable');
  });
  expect(loadTextWidth(localStorage)).toEqual({ width: 'reading', saved: false });
  render(<TextWidthControl />);
  await userEvent.click(screen.getByRole('button', { name: 'Text width' }));
  await userEvent.click(screen.getByRole('button', { name: 'Full pane width' }));
  expect(useTextWidthPreference.getState()).toMatchObject({ width: 'full', saved: false });
  await userEvent.click(screen.getByRole('button', { name: 'Text width' }));
  expect(screen.getByText(/Available for this session/)).toBeInTheDocument();
});
