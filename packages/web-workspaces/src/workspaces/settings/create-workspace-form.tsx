import { workspaces as coreWorkspaces } from '@nix/api-client';
import { Button, Field, Input, Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { useNavigate } from 'react-router';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useWorkspace } from '../workspace-context';

export function CreateWorkspaceForm(props: { readonly onCreated: () => void }): ReactNode {
  const client = useApiClient();
  const navigate = useNavigate();
  const context = useWorkspace();
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const createRequest = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      createRequest.current?.abort();
    },
    [],
  );

  async function createWorkspace(
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ): Promise<void> {
    event.preventDefault();
    if (newWorkspaceName.trim().length === 0) return;
    createRequest.current?.abort();
    const controller = new AbortController();
    createRequest.current = controller;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await client.execute(
        coreWorkspaces.createWorkspace(newWorkspaceName.trim()),
        {
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted || createRequest.current !== controller) return;
      context.workspaceCreated(created);
      void navigate(`/w/${created.id}`);
      props.onCreated();
    } catch {
      if (controller.signal.aborted) return;
      setCreateError('The workspace could not be created. Check the name and try again.');
    } finally {
      if (createRequest.current === controller) {
        createRequest.current = null;
        setCreating(false);
      }
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          void createWorkspace(event);
        }}
      >
        <Field label="New workspace name" className="min-w-0 flex-1">
          {(control) => (
            <Input
              {...control}
              value={newWorkspaceName}
              onChange={(event) => {
                setNewWorkspaceName(event.target.value);
              }}
            />
          )}
        </Field>
        <Button type="submit" disabled={creating || newWorkspaceName.trim().length === 0}>
          Create
        </Button>
      </form>
      {createError === null ? null : (
        <Text role="alert" tone="muted">
          {createError}
        </Text>
      )}
    </div>
  );
}
