import { isNixApiError, petConnections } from '@nix/api-client';
import { Button, Field, Input, Text } from '@nix/ui';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useState, type ReactElement } from 'react';

export function PetRemoteConnectionForm({
  workspaceId,
  onRegistered,
  disabled,
}: {
  readonly workspaceId: string;
  readonly onRegistered: () => void;
  readonly disabled: boolean;
}): ReactElement {
  const client = useApiClient();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [tool, setTool] = useState('');
  const [token, setToken] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid =
    /^https:\/\/\S+$/.test(url.trim()) && /^[\w.-]+$/.test(tool.trim()) && /^[!-~]+$/.test(token);

  async function register(): Promise<void> {
    setPending(true);
    setError(null);
    const credential = token;
    setToken('');
    try {
      await client.execute(
        petConnections.registerMcp(workspaceId, {
          url: url.trim(),
          tool: tool.trim(),
          token: credential,
        }),
      );
      setUrl('');
      setTool('');
      setOpen(false);
      onRegistered();
    } catch (failure) {
      setError(
        isNixApiError(failure)
          ? failure.message
          : 'Could not register the tool. Check its address, name, and token.',
      );
    } finally {
      setPending(false);
    }
  }

  if (!open) {
    return (
      <div>
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() => {
            setOpen(true);
          }}
        >
          Register MCP tool
        </Button>
      </div>
    );
  }

  return (
    <form
      className="flex min-w-0 flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !disabled && !pending) void register();
      }}
    >
      <Field label="MCP server URL">
        {(control) => (
          <Input
            {...control}
            type="url"
            value={url}
            maxLength={400}
            required
            disabled={pending}
            onChange={(event) => {
              setUrl(event.currentTarget.value);
            }}
          />
        )}
      </Field>
      <Field label="Exact tool name">
        {(control) => (
          <Input
            {...control}
            value={tool}
            maxLength={96}
            required
            disabled={pending}
            onChange={(event) => {
              setTool(event.currentTarget.value);
            }}
          />
        )}
      </Field>
      <Field label="Access token">
        {(control) => (
          <Input
            {...control}
            type="password"
            value={token}
            maxLength={8192}
            autoComplete="off"
            required
            disabled={pending}
            onChange={(event) => {
              setToken(event.currentTarget.value);
            }}
          />
        )}
      </Field>
      {error !== null ? (
        <Text variant="note" role="alert">
          {error}
        </Text>
      ) : null}
      <Text variant="note" tone="muted">
        Nix stores the token securely and asks for approval before each call to this tool.
      </Text>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" type="submit" disabled={disabled || pending || !valid}>
          {pending ? 'Registering…' : 'Register tool'}
        </Button>
        <Button
          variant="ghost"
          type="button"
          disabled={pending}
          onClick={() => {
            setToken('');
            setError(null);
            setOpen(false);
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
