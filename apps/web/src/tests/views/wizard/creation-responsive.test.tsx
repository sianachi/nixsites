import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { App } from '../../../app';
import { setZenMode } from '@nix/web-foundation/lib/zen-mode';
import { renderAt, signedIn } from '../../render-with-router';
import { stubViewport } from '../../stub-viewport';

beforeEach(() => {
  signedIn();
  stubViewport(240);
});

afterEach(() => {
  setZenMode(false);
});

it('names the setup steps and lets the keyboard toggle preview without losing the draft', async () => {
  const user = userEvent.setup();
  renderAt(<App />, '/new/board');
  await screen.findByRole('heading', { name: 'New Board' });

  expect(screen.getAllByRole('main')).toHaveLength(1);
  const steps = screen.getByRole('navigation', { name: 'Creation steps' });
  const current = within(steps).getByRole('button', { current: 'step' });
  expect(within(current).getByText('Basics').parentElement).not.toHaveClass('hidden');
  const title = screen.getByRole('textbox', { name: 'Name' });
  await user.clear(title);
  await user.type(title, 'My life plan');
  const preview = screen.getByRole('button', { name: 'Preview' });
  expect(preview).toHaveAttribute('aria-controls', 'creation-studio-preview');
  preview.focus();
  await user.keyboard('{Enter}');
  expect(screen.getByRole('button', { name: 'Hide preview' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  expect(title).toHaveValue('My life plan');
  await user.keyboard('{Enter}');
  expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.getByRole('textbox', { name: 'Name' })).toBe(title);

  await user.click(screen.getByRole('button', { name: 'Preview' }));
  expect(screen.getByRole('button', { name: 'Create Board' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Hide preview' }));

  await user.click(screen.getByRole('button', { name: 'Enter Zen mode' }));
  expect(screen.getByRole('region', { name: 'Guided setup' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Exit Zen mode' })).toBeInTheDocument();
});
