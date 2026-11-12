import { UndoBar, UndoProvider } from '@nix/ui';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PetSettingsResponse } from '@nix/api-client';
import { PetSettingsEditor } from '@nix/web-pets/pets/pet-settings-section';
import { calendarSummary } from '@nix/web-settings/settings/calendars/calendar-labels';
import { CopyBox } from '@nix/web-settings/settings/shared/copy-box';

const client = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn() }));
vi.mock('@nix/web-platform/api/api-client-provider', () => ({ useApiClient: () => client }));
vi.mock('@nix/web-pets/pets/pet-avatar', () => ({ PetAvatar: () => null }));

describe('calendarSummary', () => {
  it('counts connected accounts and syncing calendars', () => {
    expect(
      calendarSummary(
        [{ status: 'active' }, { status: 'needs_reauth' }],
        [{ status: 'active' }, { status: 'paused' }],
      ),
    ).toBe('1 account connected, 1 calendar syncing.');
    expect(calendarSummary([], [])).toBe('0 accounts connected, 0 calendars syncing.');
  });
});

describe('CopyBox', () => {
  it('says in words that the text was copied', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<CopyBox label="the command" text="nixctl mcp" />);
    await user.click(screen.getByRole('button', { name: 'Copy the command' }));
    expect(writeText).toHaveBeenCalledWith('nixctl mcp');
    expect(await screen.findByText('Copied the command.')).toBeVisible();
  });
});

const first = '11111111-1111-4111-8111-111111111111';
const pet = (id: string, name: string) => ({
  id,
  name,
  appearance: 'owl' as const,
  personality: 'calm' as const,
  responseLength: 'balanced' as const,
  instructions: '',
  applyWithoutAsking: false,
  provider: 'anthropic' as const,
});
const saved: PetSettingsResponse = {
  revision: 1,
  settings: {
    enabled: true,
    activePetId: first,
    motion: 'system',
    inlineWriting: false,
    profiles: [pet(first, 'Hoot')],
  },
};

describe('Pet settings undo', () => {
  beforeEach(() => {
    client.query.mockReset();
  });

  it('restores the removed companion and its enabled state', async () => {
    client.query.mockResolvedValue({ keys: [] });
    const user = userEvent.setup();
    render(
      <UndoProvider>
        <PetSettingsEditor initial={saved} saving={false} onSave={() => Promise.resolve(true)} />
        <UndoBar />
      </UndoProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Remove pet' }));
    expect(screen.getByRole('button', { name: 'Add pet' })).toBeVisible();
    expect(screen.getByText('Removed Hoot')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Hoot');
    expect(screen.getByRole('checkbox', { name: 'Show companion in my workspaces' })).toBeChecked();
  });
});
