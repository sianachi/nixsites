import {
  conversations,
  items,
  pets,
  type Item,
  type PetProfile,
  type CreateConversationInput,
  type Conversation,
} from '@nix/api-client';
import { Button, Checkbox, Dialog, Field, Input, Select, Text } from '@nix/ui';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useWorkspaceArrangement } from '@nix/web-workspaces/workspaces/use-workspace-arrangement';
import { PetMessageText } from '../../pets/pet-message-text';
import { Link, useNavigate } from 'react-router';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import {
  useAccessibleWorkspaces,
  useOptionalWorkspace,
} from '@nix/web-workspaces/workspaces/workspace-context';
import { readLastWorkspaceId } from '@nix/web-workspaces/workspaces/last-workspace';
import { ChatSaveTo } from './chat-save-to';
import { ChatSources } from './chat-sources';

export { ChatDestination } from './chat-destination';

export function NewChatNote({
  sourceWorkspaceIds,
  groupId,
  initialPrompt = '',
  messages,
  existingItemId,
  onClose,
}: {
  readonly sourceWorkspaceIds: readonly string[];
  readonly groupId?: string;
  readonly initialPrompt?: string;
  readonly messages?: CreateConversationInput['messages'];
  readonly existingItemId?: string;
  readonly onClose: () => void;
}): ReactNode {
  const client = useApiClient();
  const navigate = useNavigate();
  const { workspaces, status: workspaceStatus } = useAccessibleWorkspaces();
  const currentWorkspace = useOptionalWorkspace();
  const [lastWorkspaceId] = useState(readLastWorkspaceId);
  const { arrangement } = useWorkspaceArrangement();
  const remembered = arrangement.groups.find((entry) => entry.id === groupId);
  const active = workspaces.filter((entry) => entry.lifecycleState === 'active');
  const [profiles, setProfiles] = useState<readonly PetProfile[]>([]);
  const [petId, setPetId] = useState('');
  const [sources, setSources] = useState<readonly string[]>(sourceWorkspaceIds);
  const formId = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const [chosenDestination, setChosenDestination] = useState<{
    workspaceId: string;
    parentId: string | null;
  } | null>(null);
  const rememberedWorkspace = active.find(
    (entry) => entry.id === remembered?.lastDestinationWorkspaceId,
  );
  const current = active.find(
    (entry) => entry.id === (currentWorkspace?.workspaceId ?? lastWorkspaceId),
  );
  const defaultDestination =
    current ??
    rememberedWorkspace ??
    active.find((entry) => sourceWorkspaceIds.includes(entry.id)) ??
    active[0];
  const workspaceId = chosenDestination?.workspaceId ?? defaultDestination?.id ?? '';
  const parentId =
    chosenDestination !== null
      ? chosenDestination.parentId
      : !current && rememberedWorkspace
        ? (remembered?.lastDestinationParentId ?? null)
        : null;
  function setWorkspaceId(id: string): void {
    setChosenDestination({ workspaceId: id, parentId: null });
  }
  function setParentId(id: string | null): void {
    setChosenDestination({ workspaceId, parentId: id });
  }
  const [title, setTitle] = useState(initialPrompt || 'New chat');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [parentItem, setParentItem] = useState<Item | null>(null);
  const [unavailableParentId, setUnavailableParentId] = useState<string | null>(null);
  const [initialRequestId] = useState(() => crypto.randomUUID());
  const [createdChat, setCreatedChat] = useState<Conversation | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void client
      .query(pets.settings(), { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) {
          setProfiles(value.settings.profiles);
          setPetId(value.settings.activePetId ?? '');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('Pets could not be loaded.');
      });
    return () => {
      controller.abort();
    };
  }, [client]);
  const destination = active.find((entry) => entry.id === workspaceId);
  useEffect(() => {
    if (!parentId || existingItemId) return;
    const controller = new AbortController();
    void client
      .query(items.itemById(parentId), { signal: controller.signal, forceRefresh: true })
      .then((item) => {
        if (item.workspaceId !== workspaceId)
          throw new Error('Destination belongs to another workspace.');
        if (!controller.signal.aborted) {
          setParentItem(item);
          setUnavailableParentId(null);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setUnavailableParentId(parentId);
      });
    return () => {
      controller.abort();
    };
  }, [client, parentId, workspaceId, existingItemId]);
  const parentReady =
    parentId === null ||
    (parentItem?.id === parentId &&
      parentItem.workspaceId === workspaceId &&
      unavailableParentId !== parentId);
  const unavailableSources = sources.filter((id) => !active.some((entry) => entry.id === id));
  const disabled =
    busy ||
    !title.trim() ||
    !petId ||
    !sources.length ||
    unavailableSources.length > 0 ||
    (!existingItemId && (!destination || !parentReady)) ||
    !confirmed;
  async function create(): Promise<void> {
    if (disabled) return;
    setBusy(true);
    setError('');
    let saved = false;
    try {
      const chat =
        createdChat ??
        (existingItemId
          ? await client.execute(
              conversations.configure(existingItemId, { sourceWorkspaceIds: sources, petId }),
            )
          : await client.execute(
              conversations.create(workspaceId, {
                title: title.trim(),
                parentId,
                sourceWorkspaceIds: [...sources],
                petId,
                ...(groupId ? { groupId } : {}),
                ...(messages ? { messages } : {}),
              }),
            ));
      saved = true;
      setCreatedChat(chat);
      if (initialPrompt.trim())
        await client.execute(
          conversations.send(chat.itemId, { requestId: initialRequestId, text: initialPrompt }),
        );
      onClose();
      void navigate(`/w/${chat.workspaceId}?item=${chat.itemId}`);
    } catch {
      setError(
        saved
          ? 'The chat was saved, but the first message could not be confirmed. Open the saved chat before sending again.'
          : 'The chat could not be created. Check your destination and pet connection.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      title={existingItemId ? 'Set up this chat view' : messages ? 'Save as chat note' : 'New chat'}
      initialFocus={titleRef}
      onClose={() => {
        if (!busy) onClose();
      }}
      actions={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={disabled} type="submit" form={formId}>
            {busy
              ? 'Saving…'
              : createdChat
                ? 'Retry first message'
                : existingItemId
                  ? 'Set up chat'
                  : 'Create chat note'}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        {messages ? (
          <details>
            <summary>Preview retained transcript</summary>
            {messages.map((message, index) => (
              <div key={index}>
                <Text variant="kicker">{message.role}</Text>
                <PetMessageText workspaceId={sourceWorkspaceIds[0] ?? ''} text={message.text} />
              </div>
            ))}
          </details>
        ) : null}
        {messages ? (
          <Text>
            Only the retained visible messages will be copied. Older trimmed messages and hidden
            provider context are unavailable. Your original private conversation is kept.
          </Text>
        ) : null}
        <fieldset disabled={busy || createdChat !== null} className="flex flex-col gap-4">
          {!existingItemId ? (
            <Field label="Chat title">
              {(control) => (
                <Input
                  {...control}
                  ref={titleRef}
                  value={title}
                  maxLength={240}
                  onChange={(event) => {
                    setTitle(event.currentTarget.value);
                  }}
                />
              )}
            </Field>
          ) : null}
          <Field label="Pet">
            {(control) => (
              <Select
                {...control}
                value={petId}
                onChange={(event) => {
                  setPetId(event.currentTarget.value);
                }}
              >
                <option value="">Choose a pet</option>
                {profiles.map((pet) => (
                  <option key={pet.id} value={pet.id}>
                    {pet.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <ChatSources
            active={active}
            sources={sources}
            loading={workspaceStatus === 'loading'}
            onChange={(next) => {
              setSources(next);
              setConfirmed(false);
            }}
          />
          {!existingItemId ? (
            <ChatSaveTo
              active={active}
              current={current}
              destination={destination}
              workspaceId={workspaceId}
              parentId={parentId}
              parentTitle={parentId && !parentReady ? null : (parentItem?.title ?? 'Untitled note')}
              onWorkspace={(id) => {
                setWorkspaceId(id);
                setConfirmed(false);
              }}
              onParent={(id) => {
                setParentId(id);
                setConfirmed(false);
              }}
            />
          ) : null}
          {existingItemId ? (
            <>
              <Text>
                This conversation will be stored in the existing note. Anyone who can read it can
                read the transcript, including content from the selected source workspaces.
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
          {!existingItemId && destination ? (
            <>
              <Text>
                {destination.kind === 'shared' ? 'Shared workspace.' : 'Personal workspace.'}{' '}
                Everyone who can read this note can read the chat and any content drawn from its
                sources.
              </Text>
              <Checkbox
                label="I confirm this destination and its sharing"
                checked={confirmed}
                onChange={(event) => {
                  setConfirmed(event.currentTarget.checked);
                  if (event.currentTarget.checked) setChosenDestination({ workspaceId, parentId });
                }}
              />
            </>
          ) : null}
        </fieldset>
        {parentId && unavailableParentId === parentId ? (
          <Text role="alert">The destination note is unavailable. Choose somewhere else.</Text>
        ) : null}
        {error ? <Text role="alert">{error}</Text> : null}
        {createdChat ? (
          <Link to={`/w/${createdChat.workspaceId}?item=${createdChat.itemId}`}>
            Open saved chat
          </Link>
        ) : null}
      </form>
    </Dialog>
  );
}
