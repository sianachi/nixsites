import {
  items,
  messages,
  notifications,
  pets as petsResource,
  principal as principalResource,
  readMessage,
  type Item,
  type Message,
  type MessagePetState,
  type PetProfile,
} from '@nix/api-client';
import { Button, Skeleton, Text, focusRing, initialsOf } from '@nix/ui';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import { formatRelativeTime } from '@nix/web-foundation/lib/date-format';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useSharingConsent } from '@nix/web-platform/api/use-pet-sharing-consent';
import { PetAvatar } from '@nix/web-pets/pets/pet-avatar';
import { PetMessageText } from '@nix/web-pets/pets/pet-message-text';

import { MessageComposer } from './message-composer';

/** Pets answer after the request returns, so a thread that addressed one is re-read for a while. */
const POLL_MS = 3000;
const POLL_FOR_MS = 3 * 60_000;
/** Messages further apart than this start a new group, even from the same author. */
const GROUP_MS = 5 * 60_000;
const MAX_MESSAGES = 300;

/** Every message under `rootId` (the root first), oldest first. Re-read until `pollUntil` passes. */
function useThread(workspaceId: string, rootId: string, version: number, pollUntil: number) {
  const client = useApiClient();
  const [rows, setRows] = useState<readonly Item[] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const children = async (parentId: string): Promise<Item[]> => {
      const found: Item[] = [];
      for await (const row of client.paginate(
        items.listItems(workspaceId, { parentId, pageSize: 100 }),
        { signal: controller.signal, forceRefresh: true },
      )) {
        if (row.type === 'message') found.push(row);
      }
      return found;
    };
    const load = async (): Promise<void> => {
      try {
        const all: Item[] = [];
        const seen = new Set([rootId]);
        let level = await children(rootId);
        while (level.length > 0 && all.length < MAX_MESSAGES) {
          level = level.filter((row) => !seen.has(row.id));
          for (const row of level) seen.add(row.id);
          all.push(...level);
          level = (await Promise.all(level.map((row) => children(row.id)))).flat();
        }
        all.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
        if (!controller.signal.aborted) setRows(all.slice(0, MAX_MESSAGES));
      } catch {
        if (!controller.signal.aborted) setRows((current) => current ?? []);
      }
    };
    void load();
    const timer = setInterval(() => {
      if (Date.now() < pollUntil) void load();
    }, POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [client, workspaceId, rootId, version, pollUntil]);
  return rows;
}

const STATUS_TEXT: Record<MessagePetState['status'], string> = {
  pending: 'is waiting for your approval',
  working: 'is answering',
  answered: 'answered',
  failed: 'could not answer',
  declined: 'was not asked',
  expired: 'was not approved in time',
};

/** Initials on a colour the author keeps, from the chart palette so it follows the theme. */
const COLOURS = [
  'bg-series-1',
  'bg-series-2',
  'bg-series-3',
  'bg-series-4',
  'bg-series-5',
  'bg-series-6',
] as const;

function colourOf(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return COLOURS[hash % COLOURS.length] ?? COLOURS[0];
}

/**
 * Who wrote a message. Pets show their own avatar (the viewer's pets know their appearance; another
 * person's pet shows the default one). Nix holds no profile photos, so people show their initials.
 */
function appearanceOf(
  pets: readonly PetProfile[],
  id: string,
): { readonly appearance: PetProfile['appearance'] } | undefined {
  const found = pets.find((pet) => pet.id === id);
  return found ? { appearance: found.appearance } : undefined;
}

function ChatAvatar({
  author,
  pets,
}: {
  readonly author: Message['author'];
  readonly pets: readonly PetProfile[];
}): ReactNode {
  if (author.kind === 'pet') {
    return (
      <span className="flex size-10 shrink-0 items-center justify-center" aria-hidden="true">
        <PetAvatar {...appearanceOf(pets, author.id)} label={author.name} size="header" />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`flex size-10 shrink-0 select-none items-center justify-center rounded-full text-sm font-medium uppercase text-background ${colourOf(author.id)}`}
    >
      {initialsOf(author.name)}
    </span>
  );
}

/** Where each pet this message addressed stands. Only the pets' owner gets rows, so others see nothing. */
function PetTurns({
  item,
  version,
  pollUntil,
  pets,
  onStarted,
}: {
  readonly item: Item;
  readonly version: number;
  readonly pollUntil: number;
  readonly pets: readonly PetProfile[];
  readonly onStarted: () => void;
}): ReactNode {
  const client = useApiClient();
  const [rows, setRows] = useState<readonly MessagePetState[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const load = (): void => {
      client
        .query(messages.petTurns(item.id), { signal: controller.signal, forceRefresh: true })
        .then((loaded) => {
          if (!controller.signal.aborted) setRows(loaded.pets);
        })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(() => {
      if (Date.now() < pollUntil) load();
    }, POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [client, item.id, version, pollUntil, tick]);

  async function decide(petId: string, approve: boolean): Promise<void> {
    try {
      await client.execute(
        approve ? messages.approvePetTurn(item.id, petId) : messages.dismissPetTurn(item.id, petId),
      );
      if (approve) onStarted();
    } catch {
      // The row refresh below shows what is true now (it may have expired).
    }
    setTick((current) => current + 1);
  }

  return (
    <>
      {rows.map((row) => (
        <PetTurn
          key={row.petId}
          row={row}
          item={item}
          pet={pets.find((pet) => pet.id === row.petId)}
          onDecide={(approve) => decide(row.petId, approve)}
        />
      ))}
    </>
  );
}

/**
 * One pet's turn. Working is the pet's typing bubble; a turn refused for sharing consent shows the
 * review inline and starts again once it is approved; one with no provider key points to Settings.
 */
function PetTurn({
  row,
  item,
  pet,
  onDecide,
}: {
  readonly row: MessagePetState;
  readonly item: Item;
  readonly pet: PetProfile | undefined;
  readonly onDecide: (approve: boolean) => Promise<void>;
}): ReactNode {
  const client = useApiClient();
  // Core checks workspace sharing for a message turn, the scope the app's chat approves with workspace context.
  const sharing = useSharingConsent({
    client,
    workspaceId: item.workspaceId,
    petId: row.petId,
    selectionKey: `message:${item.id}`,
  });
  if (row.status === 'working') {
    return (
      <div className="flex items-end gap-2" role="status" aria-label={`${row.name} is answering`}>
        <ChatAvatar
          author={{ id: row.petId, kind: 'pet', name: row.name }}
          pets={pet ? [pet] : []}
        />
        <span
          className="flex gap-1 rounded-2xl rounded-bl-sm bg-surface px-3 py-3"
          aria-hidden="true"
        >
          {[0, 150, 300].map((delay) => (
            <span
              key={delay}
              className="size-1.5 rounded-full bg-muted motion-safe:animate-pulse"
              style={{ animationDelay: `${String(delay)}ms` }}
            />
          ))}
        </span>
      </div>
    );
  }
  const needsSharing = row.status === 'failed' && row.code === 'pets.sharing_required';
  const needsKey = row.status === 'failed' && row.code === 'pets.no_provider_key';
  return (
    <div className="flex flex-col gap-1 pl-12">
      <div className="flex flex-wrap items-center gap-2">
        <Text variant="note" tone="muted">
          {row.name} {STATUS_TEXT[row.status]}
          {row.reason && row.status !== 'pending' ? `: ${row.reason}` : ''}
        </Text>
        {row.memory ? (
          <Text variant="note" tone="muted">
            Wants to remember: {row.memory}
          </Text>
        ) : null}
        {row.status === 'pending' || row.memory ? (
          <>
            <Button
              variant="secondary"
              onClick={() => {
                void onDecide(true);
              }}
            >
              {row.memory ? 'Remember' : 'Approve'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                void onDecide(false);
              }}
            >
              Dismiss
            </Button>
          </>
        ) : null}
        {needsSharing ? (
          <Button
            variant="secondary"
            onClick={() => {
              void sharing.ensure({ kind: 'workspace' }).then((approved) => {
                if (approved) void onDecide(true);
              });
            }}
          >
            Review sharing
          </Button>
        ) : null}
        {needsKey ? (
          <Link
            to={`/w/${item.workspaceId}/settings?tab=pets`}
            className={`text-sm underline ${focusRing}`}
          >
            Add a provider key in Settings
          </Link>
        ) : null}
      </div>
      {sharing.panel}
    </div>
  );
}

function ChatMessage({
  item,
  mine,
  first,
  unread,
  pets,
}: {
  readonly item: Item;
  readonly mine: boolean;
  readonly first: boolean;
  readonly unread: boolean;
  readonly pets: readonly PetProfile[];
}): ReactNode {
  const message = readMessage(item);
  if (message === null) return <Text tone="muted">This message cannot be shown.</Text>;
  const created = new Date(item.createdAt);
  return (
    <article
      className={`flex gap-2 ${mine ? 'flex-row-reverse' : ''} ${first ? 'mt-3' : ''}`}
      aria-label={`Message from ${message.author.name}`}
    >
      {first ? (
        <ChatAvatar author={message.author} pets={pets} />
      ) : (
        <span className="size-10 shrink-0" />
      )}
      <div
        className={`flex min-w-0 max-w-[85%] flex-col gap-1 ${mine ? 'items-end' : 'items-start'}`}
      >
        {first ? (
          <Text variant="caption" tone="muted">
            <strong className="text-foreground">{mine ? 'You' : message.author.name}</strong>
            {message.author.via ? ` via ${message.author.via}` : ''}
            {message.to.length > 0 ? ` to ${message.to.map((entry) => entry.name).join(', ')}` : ''}
            {' · '}
            <time dateTime={item.createdAt} title={created.toLocaleString()}>
              {formatRelativeTime(created)}
            </time>
            {unread ? ' · New' : ''}
          </Text>
        ) : null}
        <div
          className={`min-w-0 rounded-2xl px-3 py-2 ${
            mine ? 'rounded-br-sm bg-accent-fill/15' : 'rounded-bl-sm bg-surface'
          }`}
        >
          <PetMessageText text={message.text} workspaceId={item.workspaceId} generatedUi={false} />
        </div>
      </div>
    </article>
  );
}

/** The thread as one chronological column. Replies post under the thread's first message. */
function Chat({
  root,
  unread,
  viewerId,
  pets,
}: {
  readonly root: Item;
  readonly unread: ReadonlySet<string>;
  readonly viewerId: string | null;
  readonly pets: readonly PetProfile[];
}): ReactNode {
  const [version, setVersion] = useState(0);
  const [pollUntil, setPollUntil] = useState(0);
  const replies = useThread(root.workspaceId, root.id, version, pollUntil);
  const thread = useMemo(() => [root, ...(replies ?? [])], [root, replies]);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [thread.length]);
  const startPolling = (): void => {
    setVersion((current) => current + 1);
    setPollUntil(Date.now() + POLL_FOR_MS);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="log"
        aria-label="Conversation"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3 md:px-8"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-1">
          {thread.map((item, index) => {
            const message = readMessage(item);
            const prior = thread[index - 1];
            const before = prior ? readMessage(prior) : null;
            const first =
              prior === undefined ||
              before?.author.id !== message?.author.id ||
              before?.author.via !== message?.author.via ||
              new Date(item.createdAt).getTime() - new Date(prior.createdAt).getTime() > GROUP_MS;
            return (
              <div key={item.id} className="flex flex-col gap-1">
                <ChatMessage
                  item={item}
                  mine={message?.author.kind === 'person' && message.author.id === viewerId}
                  first={first}
                  unread={unread.has(item.id)}
                  pets={pets}
                />
                {message?.to.some((entry) => entry.kind === 'pet') ? (
                  <PetTurns
                    item={item}
                    version={version}
                    pollUntil={pollUntil}
                    pets={pets}
                    onStarted={startPolling}
                  />
                ) : null}
              </div>
            );
          })}
          <div ref={end} />
        </div>
      </div>
      <div className="shrink-0 border-t border-divider px-4 py-3 md:px-8">
        <div className="mx-auto w-full max-w-3xl">
          <MessageComposer
            workspaceId={root.workspaceId}
            parentId={root.id}
            label="Message"
            onPosted={(_posted, addressedPet) => {
              if (addressedPet) startPolling();
              else setVersion((current) => current + 1);
            }}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * A message and the thread under it, as a chat. Opening it marks the notices that point at it read, which is
 * the only read state: a recipient's own, and the sender never sees it.
 */
export function MessageView({ itemId }: { readonly itemId: string }): ReactNode {
  const client = useApiClient();
  const [item, setItem] = useState<Item | null | undefined>(undefined);
  const [unread, setUnread] = useState<ReadonlySet<string>>(new Set());
  const marked = useRef(false);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [petProfiles, setPetProfiles] = useState<readonly PetProfile[]>([]);

  // Who "mine" is, and the viewer's pets' looks. Both are conveniences: without them every message sits left.
  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    client
      .query(principalResource.currentPrincipal(), options)
      .then((me) => {
        if (!controller.signal.aborted && typeof me.id === 'string') setViewerId(me.id);
      })
      .catch(() => undefined);
    client
      .query(petsResource.settings(), options)
      .then((saved) => {
        if (!controller.signal.aborted && Array.isArray(saved.settings.profiles))
          setPetProfiles(saved.settings.profiles);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [client]);

  useEffect(() => {
    const controller = new AbortController();
    marked.current = false;
    client
      .query(items.itemById(itemId), { signal: controller.signal, forceRefresh: true })
      .then((loaded) => {
        if (!controller.signal.aborted) setItem(loaded);
      })
      .catch(() => {
        if (!controller.signal.aborted) setItem(null);
      });
    return () => {
      controller.abort();
    };
  }, [client, itemId]);

  useEffect(() => {
    if (marked.current || !item) return;
    marked.current = true;
    void (async () => {
      try {
        const page = await client.query(notifications.list({ unreadOnly: true }), {
          forceRefresh: true,
        });
        const mine = page.items.filter(
          (entry) => entry.kind === 'message' && entry.itemId === itemId,
        );
        if (mine.length === 0) return;
        setUnread(new Set([itemId]));
        for (const entry of mine) await client.execute(notifications.markRead(entry.id));
      } catch {
        // Read state is a convenience; the message still shows.
      }
    })();
  }, [client, item, itemId]);

  if (item === undefined) return <Skeleton shape="block" />;
  if (item === null) return <Text tone="muted">This message is unavailable.</Text>;
  return <Chat root={item} unread={unread} viewerId={viewerId} pets={petProfiles} />;
}
