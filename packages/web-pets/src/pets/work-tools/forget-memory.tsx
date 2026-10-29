import { isNixApiError, pets } from '@nix/api-client';
import { Button, Text } from '@nix/ui';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useState, type ReactElement } from 'react';

/** The fact a completed `remember` saved, or undefined when it saved nothing new. */
function rememberedFact(result: string): string | undefined {
  try {
    const parsed = JSON.parse(result) as { remembered?: unknown; alreadyKnown?: unknown };
    return typeof parsed.remembered === 'string' && parsed.alreadyKnown !== true
      ? parsed.remembered
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Undo for a memory the pet saved without asking: the owner may not have meant it, or the pet may
 * have been steered by something it read, so the fact can be dropped right where it appeared.
 */
export function ForgetMemory({ result }: { readonly result: string }): ReactElement | null {
  const client = useApiClient();
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle');
  const fact = rememberedFact(result);
  if (fact === undefined) return null;

  async function forget(text: string): Promise<void> {
    setState('busy');
    try {
      for (let attempt = 0; ; attempt += 1) {
        const { revision, settings } = await client.query(pets.settings(), { forceRefresh: true });
        const memories = (settings.memories ?? []).filter(
          (memory) => memory.text.toLowerCase() !== text.toLowerCase(),
        );
        try {
          await client.execute(pets.saveSettings(revision, { ...settings, memories }));
          break;
        } catch (error) {
          if (attempt > 0 || !isNixApiError(error) || error.status !== 409) throw error;
        }
      }
      window.dispatchEvent(new Event('nix-pet-settings-changed'));
      setState('done');
    } catch {
      setState('failed');
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="ghost"
        disabled={state === 'busy' || state === 'done'}
        onClick={() => {
          void forget(fact);
        }}
      >
        {state === 'done' ? 'Forgotten' : 'Undo'}
      </Button>
      {state === 'failed' ? (
        <Text role="alert" variant="note">
          It could not be forgotten here. Remove it in Settings &gt; Pets &gt; Memory.
        </Text>
      ) : null}
    </div>
  );
}
