import { defineCommand } from '@nix/api-client';
import { Button, Checkbox, Field, Input, Text } from '@nix/ui';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useState, type ReactElement, type SubmitEvent } from 'react';
import { z } from 'zod';

const cookieFormat = z
  .array(
    z.strictObject({
      name: z.string().min(1).max(128),
      value: z.string().min(8).max(4096),
      path: z.string().min(1).max(512).startsWith('/'),
    }),
  )
  .min(1)
  .max(32);
const connectionSchema = z.object({ id: z.string() });

export function PetSiteSessionForm({
  workspaceId,
  disabled = false,
  onRegistered,
}: {
  readonly workspaceId: string;
  readonly disabled?: boolean;
  readonly onRegistered: () => void;
}): ReactElement {
  const client = useApiClient();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    readonly text: string;
    readonly failed: boolean;
  } | null>(null);

  async function importSite(form: HTMLFormElement): Promise<void> {
    setMessage(null);
    const data = new FormData(form);
    const providedOrigin = data.get('origin');
    const origin = typeof providedOrigin === 'string' ? providedOrigin.trim() : '';
    const importValue = data.get('cookies');
    try {
      const target = new URL(origin);
      if (
        target.protocol !== 'https:' ||
        target.origin !== origin ||
        typeof importValue !== 'string' ||
        importValue.length > 32768
      ) {
        throw new Error('invalid import');
      }

      const supplied: unknown = JSON.parse(importValue);
      const parsed = cookieFormat.parse(supplied);
      setBusy(true);
      await client.execute(
        defineCommand({
          method: 'POST',
          path:
            '/api/v1/workspaces/' +
            encodeURIComponent(workspaceId) +
            '/pet-connections/browser-site',
          operation: 'SavePetBrowserSite',
          body: {
            origin,
            cookies: parsed,
            allowSubmissions: data.has('allow-submissions'),
          },
          schema: connectionSchema,
        }),
      );
      onRegistered();
      setMessage({ text: 'Website session connected.', failed: false });
    } catch {
      setMessage({
        text: 'Could not connect this session. Check the site origin and cookie format.',
        failed: true,
      });
    } finally {
      form.reset();
      setBusy(false);
    }
  }

  function submit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!busy && !disabled) void importSite(event.currentTarget);
  }

  return (
    <div className="flex flex-col gap-2">
      <Text as="h4" variant="bodySmall">
        Website session import
      </Text>
      <form onSubmit={submit} autoComplete="off" className="flex flex-col gap-2">
        <Field label="HTTPS origin" required>
          {(control) => (
            <Input
              {...control}
              name="origin"
              type="url"
              placeholder="https://example.com"
              maxLength={2048}
              disabled={busy || disabled}
            />
          )}
        </Field>
        <Field
          label="Session cookies"
          hint="JSON list containing a name, value, and path for each cookie."
          required
        >
          {(control) => (
            <Input
              {...control}
              name="cookies"
              type="password"
              autoComplete="off"
              maxLength={32768}
              disabled={busy || disabled}
            />
          )}
        </Field>
        <Checkbox
          name="allow-submissions"
          label="Allow reviewed form submissions"
          disabled={busy || disabled}
        />
        <div>
          <Button type="submit" variant="secondary" disabled={busy || disabled}>
            {busy ? 'Connecting…' : 'Connect website session'}
          </Button>
        </div>
      </form>
      {message && (
        <Text variant="note" role={message.failed ? 'alert' : 'status'}>
          {message.text}
        </Text>
      )}
    </div>
  );
}
