import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PetSettingsEditor } from '../../pets/pet-settings-section';
import type { PetProfile, PetProviderKey, PetSettingsResponse } from '@nix/api-client';

const client = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn() }));
vi.mock('@nix/web-platform/api/api-client-provider', () => ({ useApiClient: () => client }));

vi.mock('../../pets/pet-avatar', () => ({ PetAvatar: () => null }));

const initial: PetSettingsResponse = {
  revision: 0,
  settings: {
    enabled: false,
    activePetId: null,
    motion: 'system',
    profiles: [],
    inlineWriting: false,
  },
};

function savedPet(provider: PetProfile['provider']): PetSettingsResponse {
  return {
    revision: 1,
    settings: {
      enabled: true,
      activePetId: '44444444-4444-4444-8444-444444444444',
      motion: 'system',
      inlineWriting: false,
      profiles: [
        {
          id: '44444444-4444-4444-8444-444444444444',
          name: 'Pip',
          appearance: 'owl',
          personality: 'calm',
          responseLength: 'balanced',
          instructions: '',
          applyWithoutAsking: false,
          provider,
        },
      ],
    },
  };
}

const savedClaudeKey = {
  provider: 'anthropic',
  keyHint: '1234',
  savedAt: '2026-10-13T12:00:00Z',
} satisfies PetProviderKey;
let providerKeys: readonly PetProviderKey[] = [];

async function choosePetAction(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('button', { name: 'Pet actions' }));
  await user.click(screen.getByRole('menuitem', { name }));
}

describe('pet configuration', () => {
  beforeEach(() => {
    providerKeys = [];
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
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
    });
    client.query.mockReset().mockImplementation((endpoint: { operation: string }) => {
      if (endpoint.operation === 'pets.providers') return Promise.resolve({ keys: providerKeys });
      if (endpoint.operation === 'pets.connection')
        return Promise.resolve({
          provider: 'chatgpt',
          status: 'disconnected',
          reason: 'Connect ChatGPT to use this pet.',
          canConnect: true,
        });
      return Promise.reject(new Error(`Unexpected settings query: ${endpoint.operation}`));
    });
    client.execute.mockReset().mockResolvedValue(savedClaudeKey);
  });

  it('saves an owl with an independently chosen personality', async () => {
    const save = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(<PetSettingsEditor initial={initial} saving={false} onSave={save} />);
    expect(screen.queryByRole('checkbox', { name: /read a reply aloud/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add pet' }));
    await user.clear(screen.getByRole('textbox', { name: 'Name' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Pip');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Personality' }), 'playful');
    expect(screen.getByRole('combobox', { name: 'Appearance' })).toHaveValue('owl');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(save).toHaveBeenCalledOnce();
    });
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      enabled: false,
      profiles: [
        expect.objectContaining({ name: 'Pip', appearance: 'owl', personality: 'playful' }),
      ],
    });
  });

  it.each(['eye-of-ra', 'demiurge', 'fox', 'cat'])('offers and saves %s', async (appearance) => {
    const save = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(<PetSettingsEditor initial={initial} saving={false} onSave={save} />);
    await user.click(screen.getByRole('button', { name: 'Add pet' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Appearance' }), appearance);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(save).toHaveBeenCalledOnce();
    });
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      profiles: [expect.objectContaining({ appearance })],
    });
  });

  it('duplicates with a distinct identity and clears active references when the last pet is removed', async () => {
    const save = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(<PetSettingsEditor initial={initial} saving={false} onSave={save} />);
    await user.click(screen.getByRole('button', { name: 'Add pet' }));
    await choosePetAction(user, 'Duplicate pet');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(save).toHaveBeenCalledOnce();
    });
    const value = save.mock.calls[0]?.[0] as PetSettingsResponse['settings'];
    expect(value.profiles).toHaveLength(2);
    expect(value.profiles[0]?.id).not.toBe(value.profiles[1]?.id);
    await choosePetAction(user, 'Remove pet');
    await choosePetAction(user, 'Remove pet');
    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('does not announce success after a failed save', async () => {
    const user = userEvent.setup();
    render(
      <PetSettingsEditor initial={initial} saving={false} onSave={() => Promise.resolve(false)} />,
    );
    await user.click(screen.getByRole('button', { name: 'Add pet' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.queryByText('Pet settings saved.')).not.toBeInTheDocument();
    expect(screen.getByText('Unsaved changes')).toBeVisible();
  });

  it('keeps the selected pet and save confirmation when the server advances the revision', async () => {
    const save = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    const view = render(<PetSettingsEditor initial={initial} saving={false} onSave={save} />);
    await user.click(screen.getByRole('button', { name: 'Add pet' }));
    await choosePetAction(user, 'Duplicate pet');
    const selected = screen.getByRole<HTMLInputElement>('radio', { checked: true });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Pet settings saved.')).toBeVisible();
    const settings = save.mock.calls[0]?.[0] as PetSettingsResponse['settings'];
    view.rerender(
      <PetSettingsEditor initial={{ revision: 1, settings }} saving={false} onSave={save} />,
    );
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { checked: true })).toBe(selected);
    expect(screen.getByText('Pet settings saved.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('lets a pet choose its model provider and keeps the choice in the saved document', async () => {
    const save = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(<PetSettingsEditor initial={savedPet('chatgpt')} saving={false} onSave={save} />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Model' }), 'anthropic');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(save).toHaveBeenCalled();
    });
    const saved = save.mock.calls.at(-1)?.[0] as PetSettingsResponse['settings'];
    expect(saved.profiles[0]?.provider).toBe('anthropic');
  });

  it('shows only the selected provider connection controls', async () => {
    const user = userEvent.setup();
    render(
      <PetSettingsEditor
        initial={savedPet('chatgpt')}
        saving={false}
        onSave={() => Promise.resolve(true)}
      />,
    );
    expect(await screen.findByRole('button', { name: 'Connect ChatGPT' })).toBeVisible();
    expect(screen.queryByLabelText('Claude API key')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('OpenRouter API key')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Model' }), 'anthropic');
    expect(await screen.findByLabelText('Claude API key')).toHaveAttribute('type', 'password');
    expect(screen.queryByRole('region', { name: 'ChatGPT connection' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('OpenRouter API key')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Model' }), 'openrouter');
    expect(await screen.findByLabelText('OpenRouter API key')).toHaveAttribute('type', 'password');
    expect(screen.queryByRole('region', { name: 'ChatGPT connection' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Claude API key')).not.toBeInTheDocument();
  });

  it('loads a saved Claude key hint without querying ChatGPT or returning the secret to the field', async () => {
    providerKeys = [savedClaudeKey];
    render(
      <PetSettingsEditor
        initial={savedPet('anthropic')}
        saving={false}
        onSave={() => Promise.resolve(true)}
      />,
    );
    expect(await screen.findByText(/ending 1234/)).toBeVisible();
    expect(screen.queryByLabelText('Claude API key')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Change Claude key' }));
    expect(screen.getByLabelText('Claude API key')).toHaveValue('');
    expect(screen.getByRole('region', { name: 'Claude connection' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Replace Claude key' })).toBeDisabled();
    expect(client.query).toHaveBeenCalledOnce();
    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'pets.providers' }),
      expect.anything(),
    );
    expect(screen.queryByRole('button', { name: 'Connect ChatGPT' })).not.toBeInTheDocument();
  });

  it('shows a provider key load failure and retries before allowing a key change', async () => {
    client.query.mockRejectedValueOnce(new Error('Provider storage unavailable'));
    const user = userEvent.setup();
    render(
      <PetSettingsEditor
        initial={savedPet('anthropic')}
        saving={false}
        onSave={() => Promise.resolve(true)}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your provider key could not be loaded.',
    );
    expect(screen.queryByLabelText('Claude API key')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save Claude setup' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reload key' }));

    expect(await screen.findByLabelText('Claude API key')).toHaveValue('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Claude setup' })).toBeDisabled();
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('saves the selected Claude provider before its API key', async () => {
    const operations: string[] = [];
    let finishSettingsSave: (saved: boolean) => void = () => undefined;
    const settingsSave = new Promise<boolean>((resolve) => {
      finishSettingsSave = resolve;
    });
    const save = vi.fn().mockImplementation(() => {
      operations.push('settings');
      return settingsSave;
    });
    client.execute.mockImplementation(() => {
      operations.push('key');
      return Promise.resolve(savedClaudeKey);
    });
    const user = userEvent.setup();
    render(<PetSettingsEditor initial={savedPet('chatgpt')} saving={false} onSave={save} />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Model' }), 'anthropic');
    await user.type(await screen.findByLabelText('Claude API key'), 'dummy-claude-1234');
    await user.click(screen.getByRole('button', { name: 'Save Claude setup' }));

    expect(save).toHaveBeenCalledOnce();
    expect(client.execute).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    await act(async () => {
      finishSettingsSave(true);
      await settingsSave;
    });

    expect(await screen.findByText(/ending 1234/)).toBeVisible();
    expect(operations).toEqual(['settings', 'key']);
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ profiles: [expect.objectContaining({ provider: 'anthropic' })] }),
    );
    expect(client.execute).toHaveBeenCalledOnce();
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'pets.saveProviderKey',
        path: '/api/v1/me/pets/providers/anthropic/key',
        body: { key: 'dummy-claude-1234' },
      }),
    );
    expect(screen.getByLabelText('Claude API key')).toHaveValue('');
  });

  it('does not save a provider key when the selected provider settings cannot be saved', async () => {
    const save = vi.fn().mockResolvedValue(false);
    const user = userEvent.setup();
    render(<PetSettingsEditor initial={savedPet('chatgpt')} saving={false} onSave={save} />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Model' }), 'anthropic');
    await user.type(await screen.findByLabelText('Claude API key'), 'dummy-claude-1234');
    await user.click(screen.getByRole('button', { name: 'Save Claude setup' }));

    await waitFor(() => {
      expect(save).toHaveBeenCalledOnce();
      expect(screen.getByRole('button', { name: 'Save Claude setup' })).toBeEnabled();
    });
    expect(client.execute).not.toHaveBeenCalled();
    expect(screen.queryByText(/ending 1234/)).not.toBeInTheDocument();
    expect(screen.queryByText('Claude API key saved.')).not.toBeInTheDocument();
    expect(screen.queryByText('Pet settings saved.')).not.toBeInTheDocument();
    expect(screen.getByText('Unsaved changes')).toBeVisible();
  });

  it('saves the provider setup with Enter in the API key field without submitting settings twice', async () => {
    const save = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(<PetSettingsEditor initial={savedPet('chatgpt')} saving={false} onSave={save} />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Model' }), 'anthropic');
    await user.type(await screen.findByLabelText('Claude API key'), 'dummy-claude-1234');
    await user.keyboard('{Enter}');

    expect(await screen.findByText('Claude API key saved.')).toBeVisible();
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(savedPet('anthropic').settings);
    expect(client.execute).toHaveBeenCalledOnce();
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'pets.saveProviderKey',
        path: '/api/v1/me/pets/providers/anthropic/key',
        body: { key: 'dummy-claude-1234' },
      }),
    );
    expect(screen.getByLabelText('Claude API key')).toHaveValue('');
  });

  it('validates the pet draft before saving its provider key', async () => {
    const save = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(<PetSettingsEditor initial={savedPet('anthropic')} saving={false} onSave={save} />);
    await user.clear(screen.getByRole('textbox', { name: 'Name' }));
    await user.type(await screen.findByLabelText('Claude API key'), 'dummy-claude-1234');
    await user.click(screen.getByRole('button', { name: 'Save Claude setup' }));

    expect(
      await screen.findByText('Check the name and settings of each pet before saving.'),
    ).toBeVisible();
    expect(save).not.toHaveBeenCalled();
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('replaces a saved Claude key without rewriting unchanged pet settings', async () => {
    providerKeys = [savedClaudeKey];
    const save = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(<PetSettingsEditor initial={savedPet('anthropic')} saving={false} onSave={save} />);
    await user.click(await screen.findByRole('button', { name: 'Change Claude key' }));
    await user.type(screen.getByLabelText('Claude API key'), 'replacement-1234');
    await user.click(screen.getByRole('button', { name: 'Replace Claude key' }));

    await waitFor(() => {
      expect(client.execute).toHaveBeenCalledOnce();
    });
    expect(await screen.findByText('Claude API key saved.')).toBeVisible();
    expect(screen.queryByLabelText('Claude API key')).not.toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it('uses an existing Claude key by saving the chosen provider without writing another key', async () => {
    providerKeys = [savedClaudeKey];
    const save = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    const view = render(
      <PetSettingsEditor initial={savedPet('chatgpt')} saving={false} onSave={save} />,
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Model' }), 'anthropic');
    await user.click(await screen.findByRole('button', { name: 'Use Claude' }));

    expect(await screen.findByText('Claude setup saved.')).toBeVisible();
    const saved = savedPet('anthropic');
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(saved.settings);
    expect(client.execute).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Claude API key')).toHaveValue('');

    view.rerender(<PetSettingsEditor initial={saved} saving={false} onSave={save} />);
    expect(screen.queryByRole('button', { name: 'Use Claude' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change Claude key' })).toBeVisible();
  });

  it('shows a failed key save without claiming a key was saved', async () => {
    client.execute.mockRejectedValue(new Error('Provider storage unavailable'));
    const user = userEvent.setup();
    render(
      <PetSettingsEditor
        initial={savedPet('anthropic')}
        saving={false}
        onSave={() => Promise.resolve(true)}
      />,
    );
    await user.type(await screen.findByLabelText('Claude API key'), 'dummy-claude-1234');
    await user.click(screen.getByRole('button', { name: 'Save Claude setup' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The key could not be saved. Your pet settings were saved; retry saving the key.',
    );
    expect(screen.queryByText(/ending 1234/)).not.toBeInTheDocument();
    expect(screen.queryByText('Claude API key saved.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Claude setup' })).toBeEnabled();
    expect(screen.getByLabelText('Claude API key')).toHaveValue('dummy-claude-1234');
  });

  it('clears unsaved API keys when switching providers', async () => {
    const user = userEvent.setup();
    render(
      <PetSettingsEditor
        initial={savedPet('anthropic')}
        saving={false}
        onSave={() => Promise.resolve(true)}
      />,
    );
    await user.type(await screen.findByLabelText('Claude API key'), 'unsaved-claude-key');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Model' }), 'openrouter');
    expect(await screen.findByLabelText('OpenRouter API key')).toHaveValue('');
    await user.type(screen.getByLabelText('OpenRouter API key'), 'unsaved-openrouter-key');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Model' }), 'anthropic');
    expect(await screen.findByLabelText('Claude API key')).toHaveValue('');
    expect(client.execute).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'pets.connection' }),
      expect.anything(),
    );
  });

  it('shows note context only for enabled inline AI and device options only for an enabled companion', async () => {
    const user = userEvent.setup();
    render(
      <PetSettingsEditor
        initial={savedPet('anthropic')}
        saving={false}
        onSave={() => Promise.resolve(true)}
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Chat opens' })).toBeVisible();
    expect(
      screen.queryByRole('checkbox', { name: 'Send note context with inline AI' }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Use AI while writing notes' }));
    await user.click(screen.getByRole('checkbox', { name: 'Send note context with inline AI' }));
    await user.click(screen.getByRole('checkbox', { name: 'Use AI while writing notes' }));
    expect(
      screen.queryByRole('checkbox', { name: 'Send note context with inline AI' }),
    ).not.toBeInTheDocument();
    expect(localStorage.getItem('nix.pet.inlineContext')).toBe('true');

    await user.click(screen.getByRole('checkbox', { name: 'Use AI while writing notes' }));
    await user.click(screen.getByRole('checkbox', { name: 'Show companion in my workspaces' }));
    expect(screen.queryByRole('combobox', { name: 'Chat opens' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: 'Send note context with inline AI' }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Show companion in my workspaces' }));
    expect(screen.getByRole('combobox', { name: 'Chat opens' })).toBeVisible();
    expect(
      screen.getByRole('checkbox', { name: 'Send note context with inline AI' }),
    ).toBeChecked();
  });

  it('hides floating companion position for page chat without resetting its saved placement', async () => {
    localStorage.setItem('nix.pet.placement', 'left');
    const user = userEvent.setup();
    render(
      <PetSettingsEditor
        initial={savedPet('anthropic')}
        saving={false}
        onSave={() => Promise.resolve(true)}
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Position' })).toHaveValue('left');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Chat opens' }), 'page');
    expect(screen.queryByRole('combobox', { name: 'Position' })).not.toBeInTheDocument();
    expect(localStorage.getItem('nix.pet.placement')).toBe('left');

    await user.click(screen.getByRole('checkbox', { name: 'Show companion in my workspaces' }));
    expect(screen.queryByRole('combobox', { name: 'Chat opens' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Show companion in my workspaces' }));
    expect(screen.getByRole('combobox', { name: 'Chat opens' })).toHaveValue('page');
    expect(screen.queryByRole('combobox', { name: 'Position' })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Chat opens' }), 'floating');
    expect(screen.getByRole('combobox', { name: 'Position' })).toHaveValue('left');
    expect(localStorage.getItem('nix.pet.placement')).toBe('left');
  });

  it('selects a pet with its tile, marks the active one and hides Save until something changes', async () => {
    const two = savedPet('anthropic');
    const first = two.settings.profiles[0] as PetProfile;
    const second = { ...first, id: '55555555-5555-4555-8555-555555555555', name: 'Sage' };
    const save = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(
      <PetSettingsEditor
        initial={{ ...two, settings: { ...two.settings, profiles: [first, second] } }}
        saving={false}
        onSave={save}
      />,
    );
    expect(screen.getByRole('radiogroup', { name: 'Companions' })).toBeVisible();
    expect(screen.getByRole('radio', { name: 'Pip, active' })).toBeChecked();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use this pet' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Sage' }));
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Sage');
    await user.click(screen.getByRole('button', { name: 'Use this pet' }));
    expect(screen.getByRole('radio', { name: 'Sage, active' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(save.mock.calls[0]?.[0]).toMatchObject({ activePetId: second.id });
  });

  it('keeps instructions in a disclosure that opens only when they already have text', () => {
    const withText = savedPet('anthropic');
    const pet = withText.settings.profiles[0] as PetProfile;
    const view = render(
      <PetSettingsEditor initial={savedPet('anthropic')} saving={false} onSave={vi.fn()} />,
    );
    expect(view.container.querySelector('details')).not.toHaveAttribute('open');
    view.unmount();
    const filled = render(
      <PetSettingsEditor
        initial={{
          ...withText,
          settings: { ...withText.settings, profiles: [{ ...pet, instructions: 'Be brief' }] },
        }}
        saving={false}
        onSave={vi.fn()}
      />,
    );
    expect(filled.container.querySelector('details')).toHaveAttribute('open');
  });

  it('collapses a connected ChatGPT pet to a status line until Change is pressed', async () => {
    client.query.mockImplementation((endpoint: { operation: string }) =>
      Promise.resolve(
        endpoint.operation === 'pets.connection'
          ? { provider: 'chatgpt', status: 'connected', reason: 'Connected.', canConnect: true }
          : { keys: [] },
      ),
    );
    const user = userEvent.setup();
    render(<PetSettingsEditor initial={savedPet('chatgpt')} saving={false} onSave={vi.fn()} />);
    expect(await screen.findByText('✓ Connected')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Disconnect ChatGPT' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change ChatGPT connection' }));
    expect(screen.getByRole('button', { name: 'Disconnect ChatGPT' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('button', { name: 'Change ChatGPT connection' })).toHaveFocus();
  });

  it('lists what the pet remembered and saves edits, removals, additions and the off switch', async () => {
    const user = userEvent.setup();
    const save = vi.fn(() => Promise.resolve(true));
    const remembered = {
      ...savedPet('anthropic'),
      settings: {
        ...savedPet('anthropic').settings,
        memories: [
          {
            id: '55555555-5555-4555-8555-555555555555',
            text: 'Prefers metric units.',
            createdAt: '2026-10-29T00:00:00.000Z',
          },
          {
            id: '66666666-6666-4666-8666-666666666666',
            text: 'Works in London.',
            createdAt: '2026-10-29T00:00:00.000Z',
          },
        ],
      },
    };
    render(<PetSettingsEditor initial={remembered} saving={false} onSave={save} />);

    expect(screen.getByRole('textbox', { name: 'Memory 1' })).toHaveValue('Prefers metric units.');
    await user.click(screen.getByRole('button', { name: 'Forget "Works in London."' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Add something to remember' }),
      'Likes tea.',
    );
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'When a pet learns something about you' }),
      "Don't remember",
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const saved = (save.mock.calls[0] as unknown as [PetSettingsResponse['settings']])[0];
    expect(saved.memories?.map((memory) => memory.text)).toEqual([
      'Prefers metric units.',
      'Likes tea.',
    ]);
    expect(saved.memoryMode).toBe('off');
  });
});
