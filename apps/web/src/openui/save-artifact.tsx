import { items } from '@nix/api-client';
import { Button, Checkbox, Input, Select, Text } from '@nix/ui';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { ChatDestination } from '../views/chat/new-chat-note';
import { useAccessibleWorkspaces } from '../workspaces/workspace-context';
import { fenced, fencedState } from './fence';

/**
 * Keeps a chat block as an `artifact` item: its program and the block's current values as the
 * item's body (two fenced blocks, which collab stores like any note body), so the saved copy opens
 * where the chat left it and a lock covers both. The destination and its sharing are confirmed first, as for
 * a saved insight, because the program and its state leave the conversation.
 */
export function SaveArtifact({
  program,
  state,
  defaultWorkspaceId,
  onClose,
}: {
  readonly program: string;
  /** The block's state as stored text, or null when it is too large to keep. */
  readonly state: string | null;
  readonly defaultWorkspaceId: string;
  readonly onClose: () => void;
}): ReactNode {
  const client = useApiClient();
  const { workspaces } = useAccessibleWorkspaces();
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId);
  const [parentId, setParentId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [createdId, setCreatedId] = useState<string | null>(null);
  const destination = workspaces.find((entry) => entry.id === workspaceId);

  async function save() {
    setBusy(true);
    setError('');
    try {
      const created = await client.execute(
        items.createItem(workspaceId, {
          type: 'artifact',
          title: title.trim(),
          parentId,
        }),
      );
      setCreatedId(created.id);
      try {
        const { createCompanionBodies } = await import('@nix/companion');
        await createCompanionBodies(client).append(
          created.id,
          state === null ? fenced(program) : `${fenced(program)}\n${fencedState(state)}`,
          new AbortController().signal,
        );
      } catch {
        setError(
          'The artifact was created, but its content could not be confirmed. Open it before retrying to avoid duplicates.',
        );
      }
    } catch {
      setError('The artifact could not be saved. Check your destination.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-label="Save as artifact"
      className="flex flex-col gap-3 rounded-md border border-divider bg-surface p-3"
    >
      <Text as="h3" variant="h5">
        Save as artifact
      </Text>
      <Input
        aria-label="Artifact title"
        placeholder="Title"
        value={title}
        onChange={(event) => {
          setTitle(event.currentTarget.value);
        }}
      />
      <Select
        aria-label="Artifact workspace"
        value={workspaceId}
        onChange={(event) => {
          setWorkspaceId(event.currentTarget.value);
          setParentId(null);
          setConfirmed(false);
        }}
      >
        {workspaces
          .filter((entry) => entry.lifecycleState === 'active')
          .map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
      </Select>
      <ChatDestination
        workspaceId={workspaceId}
        parentId={parentId}
        onChange={(id) => {
          setParentId(id);
          setConfirmed(false);
        }}
      />
      {destination ? (
        <Checkbox
          label={
            destination.kind === 'shared'
              ? 'Save to this shared workspace: everyone who can read the destination can use it'
              : 'Save to my personal workspace'
          }
          checked={confirmed}
          onChange={(event) => {
            setConfirmed(event.currentTarget.checked);
          }}
        />
      ) : null}
      {state === null ? (
        <Text variant="note">
          Its current values are too large to keep; it opens with its defaults.
        </Text>
      ) : null}
      {error ? <Text role="alert">{error}</Text> : null}
      {createdId ? (
        <Link className="underline" to={`/w/${workspaceId}?item=${createdId}`}>
          Open the artifact
        </Link>
      ) : null}
      <div className="flex gap-2">
        <Button
          disabled={busy || createdId !== null || !title.trim() || !destination || !confirmed}
          onClick={() => void save()}
        >
          Save
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          Close
        </Button>
      </div>
    </section>
  );
}
