import {
  items,
  messages,
  notifications,
  readMessage,
  type Item,
  type MessagePetState,
} from '@nix/api-client';
import { Button, Skeleton, Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { formatRelativeTime } from '@nix/web-foundation/lib/date-format';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { PetMessageText } from '@nix/web-pets/pets/pet-message-text';

import { MessageComposer } from './message-composer';

/** Pets answer after the request returns, so a thread that addressed one is re-read for a while. */
const POLL_MS = 3000;
const POLL_FOR_MS = 3 * 60_000;

/** The direct children of an item that are messages, oldest first. Re-read until `pollUntil` passes. */
function useReplies(workspaceId: string, parentId: string, version: number, pollUntil: number) {
  const client = useApiClient();
  const [rows, setRows] = useState<readonly Item[] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const load = async (): Promise<void> => {
      const found: Item[] = [];
      try {
        for await (const row of client.paginate(
          items.listItems(workspaceId, { parentId, pageSize: 100 }),
          { signal: controller.signal, forceRefresh: true },
        )) {
          if (row.type === 'message') found.push(row);
        }
        if (!controller.signal.aborted) setRows(found);
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
  }, [client, workspaceId, parentId, version, pollUntil]);
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

/** Where each pet this message addressed stands. Only the pets' owner gets rows, so others see nothing. */
function PetTurns({
  item,
  version,
  pollUntil,
}: {
  readonly item: Item;
  readonly version: number;
  readonly pollUntil: number;
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
    } catch {
      // The row refresh below shows what is true now (it may have expired).
    }
    setTick((current) => current + 1);
  }

  return (
    <>
      {rows.map((row) => (
        <div key={row.petId} className="flex flex-wrap items-center gap-2">
          <Text variant="note" tone="muted">
            {row.name} {STATUS_TEXT[row.status]}
            {row.reason && row.status !== 'pending' ? `: ${row.reason}` : ''}
          </Text>
          {row.status === 'pending' ? (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  void decide(row.petId, true);
                }}
              >
                Approve
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  void decide(row.petId, false);
                }}
              >
                Dismiss
              </Button>
            </>
          ) : null}
        </div>
      ))}
    </>
  );
}

function Bubble({ item, unread }: { readonly item: Item; readonly unread: boolean }): ReactNode {
  const message = readMessage(item);
  if (message === null) return <Text tone="muted">This message cannot be shown.</Text>;
  return (
    <article className="flex flex-col gap-1" aria-label={`Message from ${message.author.name}`}>
      <Text variant="caption" tone="muted">
        <strong className="text-foreground">{message.author.name}</strong>
        {message.author.kind === 'pet' ? ' (pet)' : ''}
        {message.author.via ? ` via ${message.author.via}` : ''}
        {message.to.length > 0 ? ` to ${message.to.map((entry) => entry.name).join(', ')}` : ''}
        {' · '}
        {formatRelativeTime(new Date(item.createdAt))}
        {unread ? ' · New' : ''}
      </Text>
      <PetMessageText text={message.text} workspaceId={item.workspaceId} generatedUi={false} />
    </article>
  );
}

function Node({
  item,
  depth,
  unread,
}: {
  readonly item: Item;
  readonly depth: number;
  readonly unread: ReadonlySet<string>;
}): ReactNode {
  const [version, setVersion] = useState(0);
  const [pollUntil, setPollUntil] = useState(0);
  const [replying, setReplying] = useState(false);
  const replies = useReplies(item.workspaceId, item.id, version, pollUntil);
  return (
    <div className={depth > 0 ? 'ml-4 border-l-2 border-divider pl-3' : ''}>
      <div className="flex flex-col gap-2 py-2">
        <Bubble item={item} unread={unread.has(item.id)} />
        {readMessage(item)?.to.some((entry) => entry.kind === 'pet') ? (
          <PetTurns item={item} version={version} pollUntil={pollUntil} />
        ) : null}
        <div>
          <Button
            variant="ghost"
            aria-expanded={replying}
            onClick={() => {
              setReplying((current) => !current);
            }}
          >
            Reply
          </Button>
        </div>
        {replying ? (
          <MessageComposer
            workspaceId={item.workspaceId}
            parentId={item.id}
            label="Reply"
            focusOnMount
            onPosted={(_posted, addressedPet) => {
              setVersion((current) => current + 1);
              if (addressedPet) setPollUntil(Date.now() + POLL_FOR_MS);
              setReplying(false);
            }}
          />
        ) : null}
      </div>
      {(replies ?? []).map((reply) => (
        <Node key={reply.id} item={reply} depth={depth + 1} unread={unread} />
      ))}
    </div>
  );
}

/**
 * A message and the thread under it. Opening it marks the notices that point at it read, which is
 * the only read state: a recipient's own, and the sender never sees it.
 */
export function MessageView({ itemId }: { readonly itemId: string }): ReactNode {
  const client = useApiClient();
  const [item, setItem] = useState<Item | null | undefined>(undefined);
  const [unread, setUnread] = useState<ReadonlySet<string>>(new Set());
  const marked = useRef(false);

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
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3 md:px-8">
      <div className="mx-auto w-full max-w-3xl">
        <Node item={item} depth={0} unread={unread} />
      </div>
    </div>
  );
}
