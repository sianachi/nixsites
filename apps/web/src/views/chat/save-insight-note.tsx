import { items } from '@nix/api-client';
import { createCompanionBodies } from '@nix/companion';
import { Button, Checkbox, Input, Select, Text, Textarea } from '@nix/ui';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useAccessibleWorkspaces } from '../../workspaces/workspace-context';
import { ChatDestination } from './new-chat-note';

export function SaveInsightNote({
  text,
  onClose,
}: {
  readonly text: string;
  readonly onClose: () => void;
}): ReactNode {
  const client = useApiClient();
  const { workspaces } = useAccessibleWorkspaces();
  const [workspaceId, setWorkspaceId] = useState('');
  const [parentId, setParentId] = useState<string | null>(null);
  const [title, setTitle] = useState('Conversation insight');
  const [body, setBody] = useState(text);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [createdId, setCreatedId] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    setError('');
    try {
      const created = await client.execute(
        items.createItem(workspaceId, { type: 'note', title, parentId }),
      );
      setCreatedId(created.id);
      try {
        await createCompanionBodies(client).append(created.id, body, new AbortController().signal);
        onClose();
      } catch {
        setError(
          'The note was created, but its text could not be confirmed. Open it before retrying to avoid duplicates.',
        );
      }
    } catch {
      setError('The insight could not be saved. Check your destination.');
    } finally {
      setBusy(false);
    }
  }
  const destination = workspaces.find((entry) => entry.id === workspaceId);
  return (
    <section
      aria-label="Save insight as note"
      className="flex flex-col gap-3 rounded-lg border border-divider bg-surface p-4"
    >
      <Text as="h2" variant="h4">
        Save insight as note
      </Text>
      <Input
        aria-label="Insight title"
        value={title}
        onChange={(event) => {
          setTitle(event.currentTarget.value);
        }}
      />
      <Textarea
        aria-label="Insight content"
        value={body}
        onChange={(event) => {
          setBody(event.currentTarget.value);
        }}
      />
      <Select
        aria-label="Insight destination workspace"
        value={workspaceId}
        onChange={(event) => {
          setWorkspaceId(event.currentTarget.value);
          setParentId(null);
          setConfirmed(false);
        }}
      >
        <option value="">Choose where to save</option>
        {workspaces
          .filter((entry) => entry.lifecycleState === 'active')
          .map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
      </Select>
      {workspaceId ? (
        <ChatDestination
          workspaceId={workspaceId}
          parentId={parentId}
          onChange={(id) => {
            setParentId(id);
            setConfirmed(false);
          }}
        />
      ) : null}
      {destination ? (
        <>
          <Text>
            {destination.kind === 'shared'
              ? 'This is a shared workspace.'
              : 'This is your personal workspace.'}{' '}
            Everyone who can read the destination note can read this insight, including content from
            other workspaces.
          </Text>
          <Checkbox
            label="I confirm this destination and its sharing"
            checked={confirmed}
            onChange={(event) => {
              setConfirmed(event.currentTarget.checked);
            }}
          />
        </>
      ) : null}
      {error ? <Text role="alert">{error}</Text> : null}
      {createdId ? <Link to={`/w/${workspaceId}?item=${createdId}`}>Open created note</Link> : null}
      <div className="flex gap-2">
        <Button
          disabled={
            busy || !!createdId || !title.trim() || !body.trim() || !destination || !confirmed
          }
          onClick={() => void save()}
        >
          Save insight
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          Close
        </Button>
      </div>
    </section>
  );
}
