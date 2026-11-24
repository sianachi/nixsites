import { isCanceledError, isNixApiError, pets, type PetProviderKey } from '@nix/api-client';
import { Button, Field, Input, Text } from '@nix/ui';
import { useEffect, useState, type ReactElement } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { petProviderLabels } from './catalog';
import { useChangeFocus } from './use-change-focus';

export function PetProviderKeys({
  provider,
  onSaveSettings,
  needsProviderSave,
  collapsible = false,
}: {
  readonly provider: PetProviderKey['provider'];
  readonly onSaveSettings: () => Promise<boolean>;
  readonly needsProviderSave: boolean;
  /** Shows a one-line "Key saved · Change" status while a key is stored, until Change is pressed. */
  readonly collapsible?: boolean;
}): ReactElement {
  const client = useApiClient();
  const [keys, setKeys] = useState<readonly PetProviderKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<'save' | 'remove' | 'provider' | null>(null);
  const busy = pending !== null;
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  const label = petProviderLabels[provider];
  const stored = keys?.find((entry) => entry.provider === provider);
  const saveLabel = stored ? `Replace ${label} key` : `Save ${label} setup`;
  const [editing, setEditing] = useState(false);
  const { panel, change } = useChangeFocus(editing);

  useEffect(() => {
    const controller = new AbortController();
    client
      .query(pets.providers(), { signal: controller.signal, forceRefresh: true })
      .then((response) => {
        if (!controller.signal.aborted) {
          setKeys(response.keys);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || isCanceledError(cause)) return;
        setError('Your provider key could not be loaded.');
      });
    return () => {
      controller.abort();
    };
  }, [client, reload]);

  async function save(): Promise<void> {
    const key = draft.trim();
    if (!key || busy) return;
    setPending('save');
    setError(null);
    setMessage('');
    let settingsSaved = false;
    try {
      if (!(await onSaveSettings())) return;
      settingsSaved = true;
      const saved = await client.execute(pets.saveProviderKey(provider, key));
      setKeys((current) => [
        ...(current ?? []).filter((entry) => entry.provider !== provider),
        saved,
      ]);
      setDraft('');
      setMessage(`${label} API key saved.`);
      setEditing(false);
      window.dispatchEvent(new Event('nix-pet-provider-keys-changed'));
    } catch (cause) {
      setError(
        isNixApiError(cause) && cause.detail !== undefined
          ? cause.detail
          : settingsSaved
            ? 'The key could not be saved. Your pet settings were saved; retry saving the key.'
            : 'The pet settings could not be confirmed. Your key was not changed. Try again.',
      );
    } finally {
      setPending(null);
    }
  }

  async function remove(): Promise<void> {
    if (busy) return;
    setPending('remove');
    setError(null);
    setMessage('');
    try {
      await client.execute(pets.removeProviderKey(provider));
      setKeys((current) => (current ?? []).filter((entry) => entry.provider !== provider));
      setMessage(`${label} API key removed.`);
      window.dispatchEvent(new Event('nix-pet-provider-keys-changed'));
    } catch (cause) {
      setError(
        isNixApiError(cause) && cause.detail !== undefined
          ? cause.detail
          : 'The key could not be removed.',
      );
    } finally {
      setPending(null);
    }
  }

  async function saveProviderChoice(): Promise<void> {
    if (busy) return;
    setPending('provider');
    setError(null);
    setMessage('');
    try {
      if (await onSaveSettings()) setMessage(`${label} setup saved.`);
    } catch {
      setError('The pet settings could not be saved. Try again.');
    } finally {
      setPending(null);
    }
  }

  if (
    collapsible &&
    !editing &&
    !busy &&
    !error &&
    (keys === null || (stored && !needsProviderSave))
  ) {
    return keys === null ? (
      <Text variant="note" tone="muted" role="status">
        Loading your key…
      </Text>
    ) : (
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Text as="span" variant="note" tone="muted">
          ✓ Key saved (ending {stored?.keyHint})
        </Text>
        <Button
          ref={change}
          aria-label={`Change ${label} key`}
          type="button"
          variant="ghost"
          onClick={() => {
            setEditing(true);
          }}
        >
          Change
        </Button>
        {message ? <Text role="status">{message}</Text> : null}
      </div>
    );
  }

  return (
    <section
      ref={panel}
      tabIndex={-1}
      aria-label={`${label} connection`}
      className="flex w-full min-w-0 flex-col gap-3 border border-divider p-3"
    >
      <Text variant="h5" as="h3">
        {label} connection
      </Text>
      <details>
        <summary className="min-h-11 cursor-pointer text-sm text-accent-text any-pointer-coarse:min-h-(--control-lg)">
          More<span className="sr-only"> about the {label} key</span>
        </summary>
        <Text variant="note" tone="muted">
          {`Your key is kept protected on this Nix server. Messages and shared context go to ${label} and are billed to this key. Your other ${label} pets share it.`}
        </Text>
      </details>
      {error ? <Text role="alert">{error}</Text> : null}
      {keys === null ? (
        error ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setError(null);
              setReload((value) => value + 1);
            }}
          >
            Reload key
          </Button>
        ) : (
          <Text variant="note" tone="muted" role="status">
            Loading your key…
          </Text>
        )
      ) : (
        <>
          <Text variant="note" tone="muted">
            {stored === undefined
              ? 'No API key saved. Save a key to use this provider.'
              : `Using your saved key ending ${stored.keyHint}.`}
          </Text>
          {stored && needsProviderSave ? (
            <Button
              type="button"
              variant="primary"
              disabled={busy}
              aria-busy={pending === 'provider'}
              onClick={() => void saveProviderChoice()}
            >
              {pending === 'provider' ? 'Saving setup…' : `Use ${label}`}
            </Button>
          ) : null}
          <div className="flex min-w-0 flex-col gap-2">
            <Field
              label={`${label} API key`}
              hint={
                provider === 'anthropic'
                  ? 'Get an API key from console.anthropic.com.'
                  : provider === 'openai'
                    ? 'Get an API key from platform.openai.com.'
                    : 'Get an API key from openrouter.ai.'
              }
              className="w-full min-w-0"
            >
              {(control) => (
                <Input
                  {...control}
                  type="password"
                  autoComplete="off"
                  value={draft}
                  disabled={busy}
                  onChange={(event) => {
                    setDraft(event.currentTarget.value);
                    setMessage('');
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void save();
                    }
                  }}
                />
              )}
            </Field>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={busy || !draft.trim()}
                aria-busy={pending === 'save'}
                onClick={() => void save()}
              >
                <span className="grid">
                  <span aria-hidden="true" className="invisible col-start-1 row-start-1">
                    {saveLabel}
                  </span>
                  <span className="col-start-1 row-start-1">
                    {pending === 'save' ? 'Saving…' : saveLabel}
                  </span>
                </span>
              </Button>
              {stored ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  aria-busy={pending === 'remove'}
                  onClick={() => void remove()}
                >
                  <span className="grid">
                    <span aria-hidden="true" className="invisible col-start-1 row-start-1">
                      Remove {label} key
                    </span>
                    <span className="col-start-1 row-start-1">
                      {pending === 'remove' ? 'Removing key…' : `Remove ${label} key`}
                    </span>
                  </span>
                </Button>
              ) : null}
            </div>
          </div>
          {stored ? (
            <Text variant="note" tone="muted">
              Removing this key stops every pet using {label} until you save another key.
            </Text>
          ) : null}
        </>
      )}
      {collapsible && stored && !needsProviderSave ? (
        <Button
          type="button"
          variant="ghost"
          className="self-start"
          disabled={busy}
          onClick={() => {
            setEditing(false);
          }}
        >
          Done
        </Button>
      ) : null}
      {message ? <Text role="status">{message}</Text> : null}
    </section>
  );
}
