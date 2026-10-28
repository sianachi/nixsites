import { Blueprint, Button, ContextMenu, Field, Input, Text, focusRing } from '@nix/ui';
import { workspaces as coreWorkspaces } from '@nix/api-client';
import { useLayoutEffect, useState, type ReactNode, type SyntheticEvent } from 'react';
import { Link, useNavigate } from 'react-router';

import { useApiClient } from '../api/api-client-provider';
import { ErrorPanel, LoadingPanel } from '@nix/web-foundation/components/states/status-panels';
import { claimZenSurface, toggleZenMode, useZenActive } from '@nix/web-foundation/lib/zen-mode';
import { useAccessibleWorkspaces } from './workspace-context';

/** Lists workspaces outside everyday navigation so archived work remains recoverable. */
export function ArchivedWorkspacesPage(): ReactNode {
  useLayoutEffect(claimZenSurface, []);
  const zen = useZenActive();
  const client = useApiClient();
  const { status, workspaces, error, reload, workspaceUpdated } = useAccessibleWorkspaces();
  const navigate = useNavigate();
  const [restoring, setRestoring] = useState<string | null>(null);
  const [purging, setPurging] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [creating, setCreating] = useState(false);
  const archived = workspaces.filter((workspace) => workspace.lifecycleState === 'archived');

  async function restore(workspaceId: string): Promise<void> {
    setRestoring(workspaceId);
    setMutationError(null);
    try {
      const restored = await client.execute(coreWorkspaces.restoreWorkspace(workspaceId));
      workspaceUpdated(restored);
      reload();
    } catch {
      setMutationError('The workspace could not be restored. Try again.');
    } finally {
      setRestoring(null);
    }
  }

  async function purge(workspaceId: string): Promise<void> {
    setPurging(workspaceId);
    setMutationError(null);
    try {
      await client.execute(coreWorkspaces.purgeWorkspace(workspaceId));
      const current = workspaces.find((workspace) => workspace.id === workspaceId);
      if (current) workspaceUpdated({ ...current, lifecycleState: 'purging' });
      reload();
      setConfirmation(null);
    } catch {
      setMutationError('The workspace could not be permanently deleted. Try again.');
    } finally {
      setPurging(null);
    }
  }

  async function createWorkspace(
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ): Promise<void> {
    event.preventDefault();
    const name = newWorkspaceName.trim();
    if (name.length === 0) return;

    setCreating(true);
    setMutationError(null);
    try {
      const created = await client.execute(coreWorkspaces.createWorkspace(name));
      workspaceUpdated(created);
      void navigate(`/w/${created.id}`);
    } catch {
      setMutationError('The workspace could not be created. Check the name and try again.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full min-w-0 max-w-3xl flex-col gap-4 break-words p-3 sm:gap-6 sm:p-6">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1 max-sm:basis-full">
          <Text variant="h3" as="h1">
            Archived workspaces
          </Text>
          {zen ? null : (
            <Text variant="note" tone="muted" className="mt-1 hidden max-w-2xl sm:block">
              Archived workspaces are out of everyday navigation. Restore one to make it available
              again.
            </Text>
          )}
        </div>
        <Button variant="secondary" onClick={toggleZenMode} aria-pressed={zen}>
          {zen ? 'Exit Zen' : 'Enter Zen'}
        </Button>
      </div>
      {zen ? null : (
        <Link
          to="/"
          className={`${focusRing} inline-flex min-h-11 items-center self-start text-sm text-accent-text underline`}
        >
          Back to workspaces
        </Link>
      )}

      {mutationError === null ? null : <Text role="alert">{mutationError}</Text>}

      {status === 'loading' ? (
        <LoadingPanel label="archived workspaces" />
      ) : status === 'error' ? (
        <ErrorPanel
          title="Archived workspaces could not be loaded"
          detail={error ?? 'Try again.'}
          action={
            <Button variant="secondary" onClick={reload}>
              Try again
            </Button>
          }
        />
      ) : archived.length === 0 ? (
        <Blueprint className="flex flex-col gap-3 p-4">
          <Text>No archived workspaces.</Text>
          <Text variant="note" tone="muted">
            Create a shared workspace to continue working.
          </Text>
          <form
            className="flex max-w-xl flex-col items-stretch gap-2 sm:flex-row sm:items-end"
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
              {creating ? 'Creating…' : 'Create workspace'}
            </Button>
          </form>
        </Blueprint>
      ) : (
        <div className="flex flex-col gap-3">
          {archived.map((workspace) => (
            <ContextMenu
              key={workspace.id}
              label={`Actions for ${workspace.name}`}
              items={[
                {
                  label: 'Restore workspace',
                  disabled: restoring !== null || purging !== null,
                  onSelect: () => {
                    void restore(workspace.id);
                  },
                },
                {
                  label: 'Delete permanently',
                  disabled: restoring !== null || purging !== null,
                  destructive: true,
                  onSelect: () => {
                    setConfirmation(workspace.id);
                  },
                },
              ]}
            >
              {(target) => (
                <div {...target}>
                  <Blueprint className="flex min-w-0 flex-col gap-3 p-3 sm:flex-row sm:flex-wrap sm:items-center sm:p-4">
                    <div className="min-w-0 flex-1">
                      <Text className="break-words">{workspace.name}</Text>
                      <Text variant="note" tone="muted">
                        Archived{' '}
                        {workspace.archivedAt
                          ? new Date(workspace.archivedAt).toLocaleDateString()
                          : 'recently'}
                      </Text>
                    </div>
                    <Button
                      variant="secondary"
                      disabled={restoring !== null || purging !== null}
                      onClick={() => void restore(workspace.id)}
                    >
                      {restoring === workspace.id ? 'Restoring…' : 'Restore workspace'}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={restoring !== null || purging !== null}
                      onClick={() => {
                        setConfirmation(workspace.id);
                      }}
                    >
                      Delete permanently
                    </Button>
                    {confirmation === workspace.id ? (
                      <div className="w-full border-t border-divider pt-3">
                        <Text variant="note" tone="muted">
                          This permanently deletes the workspace, its content, and its stored files.
                          It cannot be undone.
                        </Text>
                        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                          <Button
                            variant="secondary"
                            disabled={purging !== null}
                            onClick={() => {
                              setConfirmation(null);
                            }}
                          >
                            Cancel
                          </Button>
                          <Button
                            disabled={purging !== null}
                            onClick={() => void purge(workspace.id)}
                          >
                            {purging === workspace.id ? 'Deleting…' : 'Delete permanently'}
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </Blueprint>
                </div>
              )}
            </ContextMenu>
          ))}
        </div>
      )}
    </main>
  );
}
