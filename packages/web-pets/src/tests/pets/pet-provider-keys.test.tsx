import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { createNixClient, type NixClient, type PetProviderKey } from '@nix/api-client';
import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { PetProviderKeys } from '../../pets/pet-provider-keys';

const storedKey = {
  provider: 'openrouter',
  keyHint: '1234',
  savedAt: '2026-11-24T12:00:00Z',
} satisfies PetProviderKey;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup({
  needsProviderSave = true,
  onSaveSettings = vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  collapsible = false,
} = {}) {
  const execute = vi
    .fn<(operation: string) => Promise<unknown>>()
    .mockImplementation((operation) =>
      Promise.resolve(operation === 'pets.removeProviderKey' ? undefined : storedKey),
    );
  const client: NixClient = {
    ...createNixClient({
      baseUrl: 'http://nix.invalid',
      tokens: {
        getAccessToken: () => Promise.resolve(null),
        refreshAccessToken: () => Promise.resolve(null),
      },
      fetch: () => Promise.reject(new Error('Provider-key tests must not make network requests.')),
    }),
    query: (endpoint) => Promise.resolve(endpoint.schema.parse({ keys: [storedKey] })),
    execute: (endpoint) =>
      execute(endpoint.operation).then((value) => endpoint.schema.parse(value)),
  };
  const view = (needsSave: boolean) => (
    <ApiClientOverrideProvider client={client}>
      <PetProviderKeys
        provider="openrouter"
        onSaveSettings={onSaveSettings}
        needsProviderSave={needsSave}
        collapsible={collapsible}
      />
    </ApiClientOverrideProvider>
  );
  const rendered = render(view(needsProviderSave));
  return {
    execute,
    onSaveSettings,
    user: userEvent.setup(),
    rerender: (needsSave: boolean) => {
      rendered.rerender(view(needsSave));
    },
  };
}

it('names only key removal while its reply is held and keeps the saved key on refusal', async () => {
  const removal = deferred<undefined>();
  const { execute, onSaveSettings, user } = setup();
  execute.mockReturnValueOnce(removal.promise);
  await user.click(await screen.findByRole('button', { name: 'Remove OpenRouter key' }));

  const pending = screen.getByRole('button', { name: 'Removing key…' });
  expect(pending).toBeDisabled();
  expect(pending).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('button', { name: 'Replace OpenRouter key' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Use OpenRouter' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Saving…' })).toBeNull();
  expect(screen.getByText('Using your saved key ending 1234.')).toBeVisible();
  expect(onSaveSettings).not.toHaveBeenCalled();
  await user.click(pending);
  expect(execute).toHaveBeenCalledOnce();

  await act(() => {
    removal.reject(new Error('Refused'));
    return removal.promise.catch(() => undefined);
  });
  expect(screen.getByRole('alert')).toHaveTextContent('The key could not be removed.');
  expect(screen.getByText('Using your saved key ending 1234.')).toBeVisible();
  const retry = screen.getByRole('button', { name: 'Remove OpenRouter key' });
  expect(retry).toBeEnabled();
  retry.focus();
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('status')).toHaveTextContent('OpenRouter API key removed.');
  expect(screen.queryByRole('button', { name: 'Remove OpenRouter key' })).toBeNull();
});

it('names only provider choice while settings save is held and recovers after refusal', async () => {
  const settings = deferred<boolean>();
  const onSaveSettings = vi.fn<() => Promise<boolean>>().mockReturnValueOnce(settings.promise);
  const { execute, user } = setup({ onSaveSettings });
  await user.click(await screen.findByRole('button', { name: 'Use OpenRouter' }));

  const pending = screen.getByRole('button', { name: 'Saving setup…' });
  expect(pending).toBeDisabled();
  expect(pending).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('button', { name: 'Replace OpenRouter key' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Remove OpenRouter key' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Saving…' })).toBeNull();
  expect(execute).not.toHaveBeenCalled();

  await act(() => {
    settings.reject(new Error('Refused'));
    return settings.promise.catch(() => undefined);
  });
  expect(screen.getByRole('alert')).toHaveTextContent('The pet settings could not be saved.');
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByRole('button', { name: 'Use OpenRouter' })).toBeEnabled();
  onSaveSettings.mockResolvedValueOnce(true);
  await user.click(screen.getByRole('button', { name: 'Use OpenRouter' }));
  expect(await screen.findByRole('status')).toHaveTextContent('OpenRouter setup saved.');
  expect(execute).not.toHaveBeenCalled();
});

it('keeps a refused key draft concealed and waits for settings before saving or retrying it', async () => {
  const settings = deferred<boolean>();
  const keySave = deferred<PetProviderKey>();
  const onSaveSettings = vi
    .fn<() => Promise<boolean>>()
    .mockReturnValueOnce(settings.promise)
    .mockResolvedValue(true);
  const { execute, user } = setup({ onSaveSettings, needsProviderSave: false });
  execute.mockReturnValueOnce(keySave.promise);
  const input = await screen.findByLabelText('OpenRouter API key');
  await user.type(input, 'synthetic-key-5678');
  await user.keyboard('{Enter}');

  const pending = screen.getByRole('button', { name: 'Saving…' });
  expect(pending).toBeDisabled();
  expect(pending).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('button', { name: 'Remove OpenRouter key' })).toBeDisabled();
  expect(input).toHaveAttribute('type', 'password');
  expect(input).toHaveValue('synthetic-key-5678');
  expect(execute).not.toHaveBeenCalled();
  await user.keyboard('{Enter}{Enter}');
  expect(onSaveSettings).toHaveBeenCalledOnce();

  await act(() => {
    settings.resolve(true);
    return settings.promise;
  });
  expect(execute).toHaveBeenCalledOnce();
  expect(execute).toHaveBeenCalledWith('pets.saveProviderKey');
  expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  await act(() => {
    keySave.reject(new Error('Refused'));
    return keySave.promise.catch(() => undefined);
  });
  expect(screen.getByRole('alert')).toHaveTextContent('The key could not be saved.');
  expect(input).toHaveValue('synthetic-key-5678');
  expect(screen.getByText('Using your saved key ending 1234.')).toBeVisible();
  input.focus();
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('status')).toHaveTextContent('OpenRouter API key saved.');
  expect(input).toHaveValue('');
});

it('keeps the draft and makes no key write when saving settings returns false', async () => {
  const settings = deferred<boolean>();
  const onSaveSettings = vi.fn<() => Promise<boolean>>().mockReturnValueOnce(settings.promise);
  const { execute, user } = setup({ onSaveSettings, needsProviderSave: false });
  const input = await screen.findByLabelText('OpenRouter API key');
  await user.type(input, 'synthetic-key-5678');
  await user.click(screen.getByRole('button', { name: 'Replace OpenRouter key' }));
  expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();

  await act(() => {
    settings.resolve(false);
    return settings.promise;
  });
  expect(execute).not.toHaveBeenCalled();
  expect(screen.queryByRole('status')).toBeNull();
  expect(input).toHaveValue('synthetic-key-5678');
  expect(input).toHaveAttribute('type', 'password');
  expect(screen.getByRole('button', { name: 'Replace OpenRouter key' })).toBeEnabled();
  expect(screen.getByText('Using your saved key ending 1234.')).toBeVisible();
});

it('keeps the held key save visible after the caller confirms provider settings', async () => {
  const settings = deferred<boolean>();
  const keySave = deferred<PetProviderKey>();
  const onSaveSettings = vi.fn<() => Promise<boolean>>().mockReturnValueOnce(settings.promise);
  const { execute, user, rerender } = setup({ onSaveSettings, collapsible: true });
  execute.mockReturnValueOnce(keySave.promise);
  const input = await screen.findByLabelText('OpenRouter API key');
  await user.type(input, 'synthetic-key-5678');
  await user.keyboard('{Enter}');

  await act(() => {
    settings.resolve(true);
    return settings.promise;
  });
  rerender(false);
  expect(execute).toHaveBeenCalledWith('pets.saveProviderKey');
  expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  expect(input).toHaveValue('synthetic-key-5678');
  expect(screen.queryByRole('button', { name: 'Change OpenRouter key' })).toBeNull();

  await act(() => {
    keySave.resolve(storedKey);
    return keySave.promise;
  });
  expect(screen.getByRole('button', { name: 'Change OpenRouter key' })).toBeEnabled();
  expect(screen.getByRole('status')).toHaveTextContent('OpenRouter API key saved.');
});

it('cannot dismiss an explicitly opened key editor while its save is pending', async () => {
  const keySave = deferred<PetProviderKey>();
  const { execute, user } = setup({ collapsible: true, needsProviderSave: false });
  execute.mockReturnValueOnce(keySave.promise);
  await user.click(await screen.findByRole('button', { name: 'Change OpenRouter key' }));
  const input = screen.getByLabelText('OpenRouter API key');
  await user.type(input, 'synthetic-key-5678');
  await user.keyboard('{Enter}');
  expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Done' }));
  expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();

  await act(() => {
    keySave.reject(new Error('Refused'));
    return keySave.promise.catch(() => undefined);
  });
  expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
  expect(input).toHaveValue('synthetic-key-5678');
});

it('does not claim settings were saved when the settings request rejects before the key write', async () => {
  const settings = deferred<boolean>();
  const onSaveSettings = vi
    .fn<() => Promise<boolean>>()
    .mockReturnValueOnce(settings.promise)
    .mockResolvedValue(true);
  const { execute, user } = setup({ onSaveSettings });
  const input = await screen.findByLabelText('OpenRouter API key');
  await user.type(input, 'synthetic-key-5678');
  await user.keyboard('{Enter}');

  await act(() => {
    settings.reject(new Error('Settings refused'));
    return settings.promise.catch(() => undefined);
  });
  expect(execute).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).not.toHaveTextContent('Your pet settings were saved');
  expect(input).toHaveValue('synthetic-key-5678');
  expect(input).toHaveAttribute('type', 'password');
  expect(screen.getByRole('button', { name: 'Replace OpenRouter key' })).toBeEnabled();
  input.focus();
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('status')).toHaveTextContent('OpenRouter API key saved.');
  expect(execute).toHaveBeenCalledOnce();
});
