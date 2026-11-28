import {
  items,
  messages,
  notifications,
  pets as petsResource,
  principal as principalResource,
  readMessage,
  type Item,
  type Message,
  type MessageAddressee,
  type MessagePetState,
  type PetConnection,
  type PetProfile,
} from '@nix/api-client';
import { Button, Skeleton, Text, focusRing, initialsOf } from '@nix/ui';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link } from 'react-router';

import { formatRelativeTime } from '@nix/web-foundation/lib/date-format';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { PetAvatar } from '@nix/web-pets/pets/pet-avatar';
import { PetMessageText } from '@nix/web-pets/pets/pet-message-text';

import { MessageComposer } from './message-composer';

const PetWorkTools = lazy(async () => ({
  default: (await import('@nix/web-pets/pets/work-tools/pet-work-tools')).PetWorkTools,
}));

/** Pets answer after the request returns, so a thread that addressed one is re-read for a while. */
const POLL_MS = 3000;
const POLL_FOR_MS = 3 * 60_000;
/** Messages further apart than this start a new group, even from the same author. */
const GROUP_MS = 5 * 60_000;
const MAX_MESSAGES = 300;
/** Safety bound on one walk of the thread; the newest MAX_MESSAGES of what it finds are shown. */
const MAX_WALK = 3000;
const MAX_DEPTH = 50;

/** Every message under `rootId` (the root first), oldest first. Re-read while `shouldPoll` says so. */
function useThread(
  workspaceId: string,
  rootId: string,
  version: number,
  shouldPoll: () => boolean,
) {
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
        while (level.length > 0 && all.length < MAX_WALK) {
          level = level.filter((row) => !seen.has(row.id));
          for (const row of level) seen.add(row.id);
          all.push(...level);
          level = (await Promise.all(level.map((row) => children(row.id)))).flat();
        }
        all.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
        if (!controller.signal.aborted) setRows(all.slice(-MAX_MESSAGES));
      } catch {
        if (!controller.signal.aborted) setRows((current) => current ?? []);
      }
    };
    void load();
    const timer = setInterval(() => {
      if (shouldPoll()) void load();
    }, POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
    // shouldPoll reads refs, so it is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, workspaceId, rootId, version]);
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
  pollUntil,
  pets,
  onStarted,
  onWorking,
}: {
  readonly item: Item;
  readonly pollUntil: number;
  readonly pets: readonly PetProfile[];
  readonly onStarted: () => void;
  readonly onWorking: (itemId: string, working: boolean) => void;
}): ReactNode {
  const client = useApiClient();
  const [rows, setRows] = useState<readonly MessagePetState[]>([]);
  const [tick, setTick] = useState(0);
  // Only a turn still running (or a pending one right after a post) is re-read; settled turns are read once.
  const latest = useRef<readonly MessagePetState[]>([]);
  useEffect(() => {
    latest.current = rows;
  }, [rows]);
  const working = rows.some((row) => row.status === 'working');
  useEffect(() => {
    onWorking(item.id, working);
  }, [item.id, working, onWorking]);
  useEffect(
    () => () => {
      onWorking(item.id, false);
    },
    [item.id, onWorking],
  );
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
      const now = latest.current;
      if (
        now.some((row) => row.status === 'working') ||
        (Date.now() < pollUntil && now.some((row) => row.status === 'pending'))
      )
        load();
    }, POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [client, item.id, pollUntil, tick]);

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
 * What a working pet has asked to do in the workspace: the pet chat's own cards, with the same Approve and Reject,
 * for the changes (and reads) that wait on the owner. Reads the pet's turn conversation while it runs.
 */
function PetTurnTools({
  item,
  row,
}: {
  readonly item: Item;
  readonly row: MessagePetState;
}): ReactNode {
  const client = useApiClient();
  const [runtime, setRuntime] = useState<PetConnection | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    const load = (): void => {
      client
        .execute(
          petsResource.runtime({
            operation: 'read',
            workspaceId: item.workspaceId,
            petId: row.petId,
            messageId: item.id,
          }),
          { signal: controller.signal },
        )
        .then((loaded) => {
          if (!controller.signal.aborted) setRuntime(loaded);
        })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [client, item.id, item.workspaceId, row.petId]);
  if (!runtime?.tools?.length) return null;
  return (
    <div className="pl-12">
      <Suspense fallback={null}>
        <PetWorkTools
          client={client}
          runtime={runtime}
          workspaceId={item.workspaceId}
          petId={row.petId}
          petName={row.name}
          messageId={item.id}
          onChange={setRuntime}
        />
      </Suspense>
    </div>
  );
}

/**
 * One pet's turn. Working is the pet's typing bubble; one with no provider key points to Settings.
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
  if (row.status === 'working') {
    return (
      <>
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
        <PetTurnTools item={item} row={row} />
      </>
    );
  }
  const needsKey = row.status === 'failed' && row.code === 'pets.no_provider_key';
  // Turns that failed under the retired sharing review start again.
  const legacyRetry = row.status === 'failed' && row.code === 'pets.sharing_required';
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
        {legacyRetry ? (
          <Button
            variant="secondary"
            onClick={() => {
              void onDecide(true);
            }}
          >
            Try again
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

/**
 * Everyone in the chat besides the viewer, as a reply addresses them by default: people who wrote or were
 * addressed, the viewer's agents (a token's posts), and the viewer's own pets (another person's pet cannot be
 * addressed). Order is first appearance.
 */
export function chatParticipants(
  thread: readonly Item[],
  viewerId: string | null,
  pets: readonly PetProfile[],
): MessageAddressee[] {
  const own = new Set(pets.map((pet) => pet.id));
  const found = new Map<string, MessageAddressee>();
  const add = (entry: MessageAddressee): void => {
    if (entry.id === viewerId || found.has(entry.id)) return;
    if (entry.kind === 'pet' && !own.has(entry.id)) return;
    found.set(entry.id, entry);
  };
  for (const item of thread) {
    const message = readMessage(item);
    if (message === null) continue;
    const { author } = message;
    if (author.kind === 'pet') add({ id: author.id, name: author.name, kind: 'pet' });
    else if (author.tokenId && author.via)
      add({ id: author.tokenId, name: author.via, kind: 'agent' });
    else add({ id: author.id, name: author.name, kind: 'person' });
    for (const entry of message.to) add(entry);
  }
  return [...found.values()];
}

/** The thread as one chronological column. `root` is the thread's first message; replies post under it. */
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
  // Turns still working keep the thread re-read, past the window after a post; when one ends, read once more.
  const working = useRef(new Set<string>());
  const pollUntilRef = useRef(0);
  useEffect(() => {
    pollUntilRef.current = pollUntil;
  }, [pollUntil]);
  const shouldPoll = useCallback(
    () => working.current.size > 0 || Date.now() < pollUntilRef.current,
    [],
  );
  const onWorking = useCallback((itemId: string, isWorking: boolean) => {
    if (isWorking) working.current.add(itemId);
    else if (working.current.delete(itemId)) setVersion((current) => current + 1);
  }, []);
  const replies = useThread(root.workspaceId, root.id, version, shouldPoll);
  const thread = useMemo(() => [root, ...(replies ?? [])], [root, replies]);
  const participants = useMemo(
    () => chatParticipants(thread, viewerId, pets),
    [thread, viewerId, pets],
  );
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
                    pollUntil={pollUntil}
                    pets={pets}
                    onStarted={startPolling}
                    onWorking={onWorking}
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
            replyTo={participants}
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
      .then(async (opened) => {
        // A notice can link to a reply deep in a thread; the chat is the whole thread, so start at its first message.
        let top = opened;
        for (let depth = 0; top.parentId && depth < MAX_DEPTH; depth += 1) {
          const parent = await client.query(items.itemById(top.parentId), {
            signal: controller.signal,
          });
          if (parent.type !== 'message') break;
          top = parent;
        }
        if (!controller.signal.aborted) setItem(top);
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
